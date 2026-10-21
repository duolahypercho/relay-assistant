import Capacitor
import Foundation

// A link only stages a review in the already selected workspace. It never changes
// the server, carries an access key, imports a profile or starts a routine.
enum RelayTemplateLinks {
    static let preference = "relay-pending-template"
    static func receive(_ incoming: URL) {
        guard incoming.absoluteString.count <= 4096,
              let link = URLComponents(url: incoming, resolvingAgainstBaseURL: false),
              link.scheme == "relay-assistant", link.host == "template", link.port == nil,
              link.user == nil, link.password == nil, link.fragment == nil,
              ["", "/"].contains(link.path), let items = link.queryItems, items.count == 1,
              items[0].name == "url", let value = items[0].value, value.count <= 2048,
              !value.contains("\\"), value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              var source = URLComponents(string: value), source.user == nil, source.password == nil,
              source.query == nil, source.fragment == nil,
              source.percentEncodedPath.range(of: "^/share/assistant/[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { return }
        let path = source.percentEncodedPath
        source.path = "/"
        guard let origin = source.string, (try? RelayBridgeViewController.validatedServer(origin)) != nil else { return }
        source.percentEncodedPath = path
        guard let url = source.url?.absoluteString else { return }
        UserDefaults.standard.set(["id": UUID().uuidString, "url": url,
            "destination": UserDefaults.standard.string(forKey: RelayBridgeViewController.preference) ?? ""], forKey: preference)
    }
    static func peek(_ destination: String) -> [String:String]? {
        guard var item = UserDefaults.standard.dictionary(forKey: preference) as? [String:String] else { return nil }
        if item["destination"] == "" && !destination.isEmpty {
            item["destination"] = destination
            UserDefaults.standard.set(item, forKey: preference)
        }
        guard item["destination"] == destination, let id = item["id"], let url = item["url"] else { return nil }
        return ["id":id,"url":url]
    }
    static func acknowledge(_ id: String, destination: String) {
        guard let item = UserDefaults.standard.dictionary(forKey: preference) as? [String:String],
              item["id"] == id, item["destination"] == destination else { return }
        UserDefaults.standard.removeObject(forKey: preference)
    }
}

@objc(RelaySharesPlugin)
final class RelaySharesPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier="RelaySharesPlugin"
    let jsName="RelayShares"
    let pluginMethods:[CAPPluginMethod]=[CAPPluginMethod(name:"sync",returnType:CAPPluginReturnPromise),CAPPluginMethod(name:"peek",returnType:CAPPluginReturnPromise),CAPPluginMethod(name:"acknowledge",returnType:CAPPluginReturnPromise),CAPPluginMethod(name:"peekTemplate",returnType:CAPPluginReturnPromise),CAPPluginMethod(name:"acknowledgeTemplate",returnType:CAPPluginReturnPromise)]
    @objc func peekTemplate(_ call: CAPPluginCall) {
        DispatchQueue.main.async { do {
            try self.workspace()
            let destination = (self.bridge?.viewController as? RelayBridgeViewController)?.connectedServer ?? ""
            if let item = RelayTemplateLinks.peek(destination) { call.resolve(["item": item]) } else { call.resolve([:]) }
        } catch { call.reject(error.localizedDescription) } }
    }
    @objc func acknowledgeTemplate(_ call: CAPPluginCall) {
        DispatchQueue.main.async { do {
            try self.workspace()
            guard let id = call.getString("id") else { throw RelayShareStore.error("This template has no receipt.") }
            RelayTemplateLinks.acknowledge(id, destination: (self.bridge?.viewController as? RelayBridgeViewController)?.connectedServer ?? "")
            call.resolve()
        } catch { call.reject(error.localizedDescription) } }
    }
    private func workspace() throws {
        guard let controller=bridge?.viewController as? RelayBridgeViewController,let current=bridge?.webView?.url,
              ["/","/index.html"].contains(current.path.isEmpty ? "/" : current.path) else {throw RelayShareStore.error("Open the main Relay workspace to use sharing.")}
        let expected=controller.connectedServer
        if expected.isEmpty {
            guard current.scheme=="capacitor",current.host=="localhost" else {throw RelayShareStore.error("Open Relay to use sharing.")}
        } else {
            guard let address=URL(string:expected), current.scheme==address.scheme,current.host==address.host,current.port==address.port else {throw RelayShareStore.error("This share belongs to another server.")}
        }
    }
    @objc func sync(_ call:CAPPluginCall) {
        DispatchQueue.main.async { self.syncOnMain(call) }
    }
    private func syncOnMain(_ call:CAPPluginCall) {
        do {
            try workspace()
            guard let scope=call.getString("scope"),let label=call.getString("label"),let chats=call.getArray("chats",JSObject.self) else {throw RelayShareStore.error("Open Relay to refresh your chats.")}
            let values=try chats.map { row -> RelayShareChat in guard let id=row["id"] as? String,let title=row["title"] as? String else {throw RelayShareStore.error("A chat could not be read.")};return RelayShareChat(id:id,title:title) }
            try RelayShareStore().sync(RelayShareContext(scope:scope,label:label,chats:values));call.resolve()
        } catch {call.reject(error.localizedDescription)}
    }
    @objc func peek(_ call:CAPPluginCall) {
        DispatchQueue.main.async { self.peekOnMain(call) }
    }
    private func peekOnMain(_ call:CAPPluginCall) {
        do {
            try workspace()
            guard let scope=call.getString("scope") else {throw RelayShareStore.error("Open the matching workspace.")}
            let store=try RelayShareStore();guard try store.context().scope==scope else {throw RelayShareStore.error("Refresh your workspace before attaching.")}
            if let item=try store.peek(scope:scope) {call.resolve(with:["item":item])} else {call.resolve([:])}
        } catch {call.reject(error.localizedDescription)}
    }
    @objc func acknowledge(_ call:CAPPluginCall) {
        DispatchQueue.main.async { self.acknowledgeOnMain(call) }
    }
    private func acknowledgeOnMain(_ call:CAPPluginCall) {
        do {try workspace();guard let scope=call.getString("scope"),let id=call.getString("id") else {throw RelayShareStore.error("This share has no receipt.")};try RelayShareStore().acknowledge(id:id,scope:scope);call.resolve()} catch {call.reject(error.localizedDescription)}
    }
}
