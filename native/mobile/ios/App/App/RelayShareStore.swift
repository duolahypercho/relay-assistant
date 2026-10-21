import Foundation
import UniformTypeIdentifiers
import UIKit
import Darwin

struct RelayShareChat: Codable { let id: String; let title: String }
struct RelayShareContext: Codable { let scope: String; let label: String; let chats: [RelayShareChat] }
struct RelayShareFile: Codable { let name: String; let mime: String; let base64: String }
struct RelayShareItem: Codable {
    let id: String
    let scope: String
    var threadId: String?
    let text: String
    let files: [RelayShareFile]
}
// Shared by the containing app and its Share extension. No cookies or keys enter this store.
final class RelayShareStore {
    static let group = "group.org.relay.assistant.shared"
    static let maxBytes = 8 * 1024 * 1024
    let root: URL
    init(root: URL? = nil) throws {
        guard let location = root ?? FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.group)?.appendingPathComponent("RelayShares", isDirectory: true) else {
            throw Self.error("Sharing needs the Relay app-group entitlement. Open the signed Relay app once first.")
        }
        self.root = location
        try FileManager.default.createDirectory(at: location, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    }
    static func error(_ message: String) -> NSError { NSError(domain: "RelayShares", code: 1, userInfo: [NSLocalizedDescriptionKey:message]) }
    private func locked<T>(_ work: () throws -> T) throws -> T {
        let fd = Darwin.open(root.appendingPathComponent(".lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw Self.error("Shared items could not be opened.") }
        defer { Darwin.close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { throw Self.error("Shared items are busy. Try again.") }
        defer { flock(fd, LOCK_UN) }
        return try work()
    }
    func sync(_ context: RelayShareContext) throws {
        guard !context.scope.isEmpty, context.scope.utf8.count <= 1000, context.label.utf8.count <= 300, context.chats.count <= 200,
              Set(context.chats.map(\.id)).count == context.chats.count,
              context.chats.allSatisfy({ Self.validID($0.id) && !$0.title.isEmpty && $0.title.utf8.count <= 500 }) else { throw Self.error("Open Relay to refresh the conversation list.") }
        try locked { try JSONEncoder().encode(context).write(to: root.appendingPathComponent("context.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
    }
    func context() throws -> RelayShareContext {
        try locked { try JSONDecoder().decode(RelayShareContext.self, from: Data(contentsOf: root.appendingPathComponent("context.json"))) }
    }
    static func validID(_ value: String) -> Bool { !value.isEmpty && value.utf8.count <= 100 && value.range(of: "^[a-zA-Z0-9_-]+$", options:.regularExpression) != nil }
    static func validate(_ item: RelayShareItem) throws {
        guard UUID(uuidString:item.id) != nil, !item.scope.isEmpty, item.scope.utf8.count <= 1000,
              item.text.utf16.count <= 12000, item.files.count <= 8,
              !item.text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || !item.files.isEmpty,
              item.threadId == nil || validID(item.threadId!) else { throw error("Share up to eight files and 12,000 characters.") }
        var size = 0
        for file in item.files {
            guard !file.name.isEmpty, file.name.utf16.count <= 240, ![".",".."].contains(file.name),
                  !file.name.contains("/"), !file.name.contains("\\"), !file.name.unicodeScalars.contains(where:{CharacterSet.controlCharacters.contains($0)}),
                  file.mime.range(of:"^[a-zA-Z0-9_.+-]+/[a-zA-Z0-9_.+-]+$",options:.regularExpression) != nil, file.mime.count <= 120,
                  file.base64.count <= 11184812, let bytes = Data(base64Encoded:file.base64) else { throw error("One of these files could not be shared.") }
            size += bytes.count
        }
        guard size <= maxBytes else { throw error("Share up to 8 MB at a time.") }
    }
    private func entries() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at:root,includingPropertiesForKeys:[.creationDateKey]).filter{$0.lastPathComponent.hasPrefix("item-") && $0.pathExtension == "json"}.sorted{$0.lastPathComponent < $1.lastPathComponent}
    }
    func enqueue(_ item: RelayShareItem) throws {
        try Self.validate(item)
        try locked {
            let url = root.appendingPathComponent("item-\(item.id).json")
            if FileManager.default.fileExists(atPath:url.path) {
                let existing = try JSONDecoder().decode(RelayShareItem.self,from:Data(contentsOf:url))
                guard existing.scope == item.scope else {throw Self.error("That share belongs to another workspace.")}
                return
            }
            guard try entries().count < 12 else { throw Self.error("Open Relay to attach or discard your waiting shares first.") }
            try JSONEncoder().encode(item).write(to:url,options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication])
        }
    }
    func peek(scope:String) throws -> RelayShareItem? {
        try locked {
            for url in try entries() {
                let attributes = try url.resourceValues(forKeys:[.fileSizeKey])
                guard (attributes.fileSize ?? 0) <= 12 * 1024 * 1024 else {throw Self.error("A waiting share is too large.")}
                let item = try JSONDecoder().decode(RelayShareItem.self,from:Data(contentsOf:url))
                if item.scope == scope {try Self.validate(item);return item}
            }
            return nil
        }
    }
    func acknowledge(id:String,scope:String) throws {
        guard UUID(uuidString:id) != nil else {throw Self.error("This share has an invalid receipt.")}
        try locked {
            let url=root.appendingPathComponent("item-\(id).json")
            guard FileManager.default.fileExists(atPath:url.path) else {return}
            let item=try JSONDecoder().decode(RelayShareItem.self,from:Data(contentsOf:url))
            guard item.scope==scope else {throw Self.error("That share belongs to another workspace.")}
            try FileManager.default.removeItem(at:url)
        }
    }
}

// Provider file URLs are temporary. Copy bytes inside the callback, never retain or fetch a URL.
enum RelayShareLoader {
    static func load(_ providers:[NSItemProvider], scope:String) async throws -> RelayShareItem {
        guard !providers.isEmpty, providers.count <= 8 else {throw RelayShareStore.error("Share up to eight items at a time.")}
        var texts=[String](),files=[RelayShareFile]()
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier), !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                // Ask Foundation to decode its URL object representation (including binary plist).
                let address=try await link(provider)
                guard let url=address, ["http","https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil, url.user==nil,url.password==nil else {throw RelayShareStore.error("Share an HTTP or HTTPS link without a password.")}
                texts.append(url.absoluteString)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                let value=try await item(provider,type:UTType.plainText.identifier)
                guard let text=(value as? String) ?? (value as? Data).flatMap({String(data:$0,encoding:.utf8)}) else {throw RelayShareStore.error("This text could not be read.")}
                texts.append(text)
            } else {
                let types=provider.registeredTypeIdentifiers.compactMap{UTType($0)}
                guard let type=types.first(where:{$0.conforms(to:.data) && !$0.conforms(to:.url)}) else {throw RelayShareStore.error("Choose a photo, file, link or plain text.")}
                let file=try await (type.conforms(to:.image) && type.preferredMIMEType == nil ? loadImage(provider) : loadFile(provider,type:type))
                files.append(file)
                guard files.reduce(0, { $0 + $1.base64.utf8.count }) <= 11184812 else {throw RelayShareStore.error("Share up to 8 MB at a time.")}
            }
        }
        let result=RelayShareItem(id:UUID().uuidString,scope:scope,text:texts.joined(separator:"\n\n"),files:files)
        try RelayShareStore.validate(result)
        return result
    }
    static func link(_ provider:NSItemProvider) async throws -> URL? {
        try await withCheckedThrowingContinuation { next in
            provider.loadObject(ofClass:NSURL.self) { value,error in
                if let error=error {next.resume(throwing:error)} else {next.resume(returning:value as? URL)}
            }
        }
    }
    static func item(_ provider:NSItemProvider,type:String) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { next in provider.loadItem(forTypeIdentifier:type,options:nil) { value,error in
            if let error=error {next.resume(throwing:error)} else if let value=value {next.resume(returning:value)} else {next.resume(throwing:RelayShareStore.error("This shared item could not be read."))}
        }}
    }
    // UIKit sometimes supplies only public.image, with no concrete filename or MIME type.
    static func loadImage(_ provider:NSItemProvider) async throws -> RelayShareFile {
        let value=try await item(provider,type:UTType.image.identifier)
        var image=value as? UIImage
        if image==nil,let data=value as? Data,data.count<=RelayShareStore.maxBytes {
            // Older share-sheet providers encode UIImage itself instead of PNG/JPEG bytes.
            // Secure decoding permits only UIImage and its own declared safe dependencies.
            image=UIImage(data:data)
            if image==nil {image=try NSKeyedUnarchiver.unarchivedObject(ofClass:UIImage.self,from:data)}
        }
        guard let image=image, image.size.width * image.size.height * image.scale * image.scale <= 40000000,
              let data=image.pngData(),data.count<=RelayShareStore.maxBytes else {throw RelayShareStore.error("Choose a smaller photo, up to 8 MB.")}
        let name=((provider.suggestedName ?? "Shared photo") as NSString).deletingPathExtension+".png"
        return RelayShareFile(name:name,mime:"image/png",base64:data.base64EncodedString())
    }
    static func loadFile(_ provider:NSItemProvider,type:UTType) async throws -> RelayShareFile {
        let suggestedName=provider.suggestedName
        return try await withCheckedThrowingContinuation { next in provider.loadFileRepresentation(forTypeIdentifier:type.identifier) { url,error in
            do {
                if let error=error {throw error}
                guard let url=url else {throw RelayShareStore.error("This file is unavailable.")}
                let info=try url.resourceValues(forKeys:[.isRegularFileKey,.fileSizeKey])
                guard info.isRegularFile==true,let size=info.fileSize,size<=RelayShareStore.maxBytes else {throw RelayShareStore.error("Share files totalling up to 8 MB.")}
                let data=try Data(contentsOf:url)
                let name=suggestedName ?? url.lastPathComponent
                let filename=URL(fileURLWithPath:name).pathExtension.isEmpty ? name + "." + (type.preferredFilenameExtension ?? "bin") : name
                next.resume(returning:RelayShareFile(name:filename,mime:type.preferredMIMEType ?? "application/octet-stream",base64:data.base64EncodedString()))
            } catch {next.resume(throwing:error)}
        }}
    }
}
