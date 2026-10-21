import XCTest
import UniformTypeIdentifiers
import UIKit
@testable import App

final class SharingTests:XCTestCase {
    var root:URL!
    var store:RelayShareStore!
    override func setUpWithError() throws {
        root=FileManager.default.temporaryDirectory.appendingPathComponent("relay-sharing-test-"+UUID().uuidString)
        store=try RelayShareStore(root:root)
    }
    override func tearDownWithError() throws {try FileManager.default.removeItem(at:root)}
    func payload(_ text:String="A little note",scope:String="workspace-a") -> RelayShareItem {
        RelayShareItem(id:UUID().uuidString,scope:scope,threadId:"main",text:text,files:[])
    }
    func testInboxSurvivesReopenIsScopedAndAcknowledgesOnlyExactReceipt() throws {
        try store.sync(RelayShareContext(scope:"workspace-a",label:"My server",chats:[RelayShareChat(id:"main",title:"Main chat")]))
        let a=payload(),b=payload("Other",scope:"workspace-b")
        try store.enqueue(a);try store.enqueue(a);try store.enqueue(b)
        let reopened=try RelayShareStore(root:root)
        XCTAssertEqual(try reopened.context().chats.first?.title,"Main chat")
        XCTAssertEqual(try reopened.peek(scope:"workspace-a")?.id,a.id)
        XCTAssertEqual(try reopened.peek(scope:"workspace-b")?.id,b.id)
        XCTAssertNil(try reopened.peek(scope:"workspace-c"))
        XCTAssertThrowsError(try reopened.acknowledge(id:a.id,scope:"workspace-b"))
        XCTAssertThrowsError(try reopened.acknowledge(id:"../context",scope:"workspace-a"))
        try reopened.acknowledge(id:a.id,scope:"workspace-a");try reopened.acknowledge(id:a.id,scope:"workspace-a")
        XCTAssertNil(try reopened.peek(scope:"workspace-a"));XCTAssertEqual(try reopened.peek(scope:"workspace-b")?.id,b.id)
    }
    func testShareByteLimitsNamesAndQueueBound() throws {
        let bytes=Data([0,1,127,128,255]),file=RelayShareFile(name:"旅行.txt",mime:"text/plain",base64:bytes.base64EncodedString())
        let item=RelayShareItem(id:UUID().uuidString,scope:"a",text:"",files:[file]);try store.enqueue(item)
        XCTAssertEqual(Data(base64Encoded:try store.peek(scope:"a")!.files[0].base64),bytes)
        for name in ["../secret","a/b","a\\b","bad\nname",String(repeating:"a",count:241)] {
            let bad=RelayShareItem(id:UUID().uuidString,scope:"a",text:"",files:[RelayShareFile(name:name,mime:"text/plain",base64:"")]);XCTAssertThrowsError(try store.enqueue(bad))
        }
        XCTAssertThrowsError(try store.enqueue(payload(String(repeating:"a",count:12001))))
        XCTAssertThrowsError(try store.enqueue(RelayShareItem(id:UUID().uuidString,scope:"a",text:"",files:[RelayShareFile(name:"large.bin",mime:"application/octet-stream",base64:Data(repeating:0,count:RelayShareStore.maxBytes+1).base64EncodedString())])))
        for _ in 0..<11 {try store.enqueue(payload())};XCTAssertThrowsError(try store.enqueue(payload()))
    }
    func testActualItemProvidersDeliverTextAndURLWithoutNetworkFetch() async throws {
        let providers=[NSItemProvider(object:"A shared note" as NSString),NSItemProvider(object:URL(string:"https://example.invalid/only-a-link")! as NSURL)]
        let item=try await RelayShareLoader.load(providers,scope:"a")
        XCTAssertEqual(item.text,"A shared note\n\nhttps://example.invalid/only-a-link");XCTAssertTrue(item.files.isEmpty)
        XCTAssertThrowsError(try RelayShareStore.validate(payload(String(repeating:"😀",count:6001))))
    }
    func testActualFileProviderCopiesBeforeTemporaryURLExpires() async throws {
        let url=root.appendingPathComponent("example.pdf"),bytes=Data("%PDF-1.7 test file".utf8)
        try bytes.write(to:url)
        let provider=NSItemProvider();provider.suggestedName="example.pdf"
        provider.registerFileRepresentation(forTypeIdentifier:UTType.pdf.identifier,fileOptions:[],visibility:.all){callback in callback(url,false,nil);return nil}
        let item=try await RelayShareLoader.load([provider],scope:"a")
        try FileManager.default.removeItem(at:url)
        XCTAssertEqual(item.files.first?.mime,"application/pdf");XCTAssertEqual(item.files.first?.name,"example.pdf");XCTAssertEqual(Data(base64Encoded:item.files[0].base64),bytes)
        try store.enqueue(item);XCTAssertEqual(try store.peek(scope:"a")?.files[0].base64,bytes.base64EncodedString())
    }
    func testActualImageProviderKeepsPNGBytes() async throws {
        let png=Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4WYAAAAASUVORK5CYII=")!
        let url=root.appendingPathComponent("picture.png");try png.write(to:url)
        let provider=NSItemProvider();provider.suggestedName="picture.png"
        provider.registerFileRepresentation(forTypeIdentifier:UTType.png.identifier,fileOptions:[],visibility:.all){callback in callback(url,false,nil);return nil}
        let item=try await RelayShareLoader.load([provider],scope:"a");XCTAssertEqual(item.files[0].mime,"image/png");XCTAssertEqual(Data(base64Encoded:item.files[0].base64),png)
    }
    func testUIKitImageHasConcreteImageType() async throws {
        let image=UIGraphicsImageRenderer(size:CGSize(width:24,height:24)).image { context in
            UIColor.systemGreen.setFill();context.fill(CGRect(x:0,y:0,width:24,height:24))
        }
        let item=try await RelayShareLoader.load([NSItemProvider(object:image)],scope:"a")
        XCTAssertEqual(item.files.count,1);XCTAssertTrue(UTType(mimeType:item.files[0].mime)?.conforms(to:.image) == true)
        XCTAssertFalse(item.files[0].name.hasSuffix(".bin"))
        XCTAssertNotNil(UIImage(data:Data(base64Encoded:item.files[0].base64)!))
    }
    func testLegacyShareSheetImageArchiveProducesUsablePNG() async throws {
        let image=UIGraphicsImageRenderer(size:CGSize(width:24,height:24)).image { context in
            UIColor.systemGreen.setFill();context.fill(CGRect(x:0,y:0,width:24,height:24))
        }
        let data=try NSKeyedArchiver.archivedData(withRootObject:image,requiringSecureCoding:true)
        let provider=NSItemProvider();provider.suggestedName="A photo"
        provider.registerDataRepresentation(forTypeIdentifier:UTType.image.identifier,visibility:.all){callback in callback(data,nil);return nil}
        let result=try await RelayShareLoader.load([provider],scope:"a")
        XCTAssertEqual(result.files[0].mime,"image/png");XCTAssertEqual(result.files[0].name,"A photo.png")
        XCTAssertEqual(UIImage(data:Data(base64Encoded:result.files[0].base64)!)?.size.width,image.size.width*image.scale)
    }
    func testUnsafeLinksAndUnsupportedProvidersFailWithoutQueueChanges() async throws {
        for url in ["javascript:alert(1)","https://user:password@example.invalid/"] {
            do {_ = try await RelayShareLoader.load([NSItemProvider(object:URL(string:url)! as NSURL)],scope:"a");XCTFail("Unsafe link accepted")}catch{}
        }
        do {_ = try await RelayShareLoader.load([NSItemProvider()],scope:"a");XCTFail("Empty provider accepted")}catch{}
        XCTAssertNil(try store.peek(scope:"a"))
    }
}
