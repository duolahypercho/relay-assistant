import XCTest
import WebKit
import Network
@testable import App

@MainActor
final class ResultsTests: XCTestCase {

    func testTemplateLinksAreScopedAndRejectMalformedSources() throws {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: RelayTemplateLinks.preference)
        let previousServer = defaults.object(forKey: RelayBridgeViewController.preference)
        defer { defaults.set(previous, forKey: RelayTemplateLinks.preference); defaults.set(previousServer, forKey: RelayBridgeViewController.preference) }
        defaults.removeObject(forKey: RelayTemplateLinks.preference)
        defaults.set("https://recipient.example/", forKey: RelayBridgeViewController.preference)
        let source = "https://publisher.example/share/assistant/" + String(repeating: "a", count: 43)
        func link(_ value: String) -> URL {
            var parts = URLComponents(); parts.scheme = "relay-assistant"; parts.host = "template"; parts.queryItems = [URLQueryItem(name: "url", value: value)]; return parts.url!
        }
        RelayTemplateLinks.receive(link(source))
        let first = try XCTUnwrap(RelayTemplateLinks.peek("https://recipient.example/"))
        XCTAssertEqual(first["url"], source); XCTAssertNil(RelayTemplateLinks.peek("https://other.example/"))
        for invalid in [source + "?key=secret", source + "#x", source + "/extra", source.replacingOccurrences(of: "publisher.example", with: "person:secret@publisher.example"), source.replacingOccurrences(of: "publisher.example", with: "publisher.example:22"), source.replacingOccurrences(of: "/share/", with: "/x/../share/"), source.replacingOccurrences(of: "https:", with: "http:")] {
            RelayTemplateLinks.receive(link(invalid)); XCTAssertEqual(RelayTemplateLinks.peek("https://recipient.example/"), first)
        }
        RelayTemplateLinks.receive(URL(string: link(source).absoluteString + "&url=x")!)
        XCTAssertEqual(RelayTemplateLinks.peek("https://recipient.example/"), first)
        RelayTemplateLinks.acknowledge(first["id"]!, destination: "https://other.example/")
        XCTAssertEqual(RelayTemplateLinks.peek("https://recipient.example/"), first)
        RelayTemplateLinks.receive(link(source))
        let second = try XCTUnwrap(RelayTemplateLinks.peek("https://recipient.example/"))
        RelayTemplateLinks.acknowledge(first["id"]!, destination: "https://recipient.example/")
        XCTAssertEqual(RelayTemplateLinks.peek("https://recipient.example/"), second)
        RelayTemplateLinks.acknowledge(second["id"]!, destination: "https://recipient.example/")
        XCTAssertNil(RelayTemplateLinks.peek("https://recipient.example/"))
        XCTAssertEqual(defaults.string(forKey: RelayBridgeViewController.preference), "https://recipient.example/")
    }
    func testDeviceConnectionLinksKeepOnlyCanonicalServerPreferences() throws {
        let token = String(repeating: "a", count: 43)
        let input = try RelayBridgeViewController.connectionInput("https://relay.example/#connect=" + token)
        XCTAssertEqual(input.server, "https://relay.example/")
        XCTAssertEqual(input.link, "https://relay.example/#connect=" + token)
        XCTAssertNil(try RelayBridgeViewController.connectionInput("https://relay.example/").link)
        for value in ["http://127.0.0.1/#connect=" + token, "https://relay.example/#connect=" + token + "x", "https://user:pass@relay.example/#connect=" + token, "https://relay.example/path#connect=" + token, "https://relay.example/?q=1#connect=" + token, "https://relay.example/#connect=" + token + "&next=evil"] {
            XCTAssertThrowsError(try RelayBridgeViewController.connectionInput(value))
        }
    }
    var controller: RelayPreviewController?
    var window: UIWindow?
    override func tearDown() {
        controller?.stop()
        window?.isHidden = true
        window = nil
        controller = nil
        super.tearDown()
    }
    func open(_ source: String) async throws -> WKWebView {
        let view = RelayResultContent.webView()
        XCTAssertFalse(view.configuration.websiteDataStore.isPersistent)
        XCTAssertEqual(view.configuration.userContentController.userScripts.count, 0)
        let observer = WKUserScript(source: "window.receipts=[];window.addEventListener('message',event=>window.receipts.push(event.data));window.addEventListener('securitypolicyviolation',event=>window.receipts.push('outer-policy:'+event.violatedDirective));", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        view.configuration.userContentController.addUserScript(observer)
        let host = UIViewController()
        if let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
            window = UIWindow(windowScene: scene)
        } else { window = UIWindow(frame: UIScreen.main.bounds) }
        window?.rootViewController = host
        window?.makeKeyAndVisible()
        host.view.addSubview(view)
        view.frame = host.view.bounds
        let delegate = RelayPreviewController(title: "Test", source: source)
        controller = delegate
        view.navigationDelegate = delegate
        view.uiDelegate = delegate
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            RelayResultContent.load(view, source: source) { error in
                if let error = error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
        return view
    }
    func receipt(_ view: WKWebView, containing word: String) async throws -> String {
        for _ in 0..<600 {
            let value = (try? await view.evaluateJavaScript("JSON.stringify(window.receipts||[])")) as? String ?? ""
            if value.contains(word) { return value }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let diagnostic = (try? await view.evaluateJavaScript("JSON.stringify({url:location.href,ready:document.readyState,frames:document.querySelectorAll('iframe').length,receipts:window.receipts})")) as? String ?? "unavailable"
        XCTFail("No receipt: \(word). \(diagnostic)")
        throw RelayResultContent.error("Missing preview receipt: \(word)")
    }
    func testInteractivePreviewHasNoDeviceBridgeOrAccountStore() async throws {
        let source = """
        <button id="tap" onclick="parent.postMessage('clicked','*')">Tap</button><script>
        let parentBlocked=false,cookieBlocked=false,storageBlocked=false;
        try{parent.document.body.dataset.bad='yes'}catch{parentBlocked=true}
        try{document.cookie='relay_preview_probe=1;path=/';cookieBlocked=document.cookie===''}catch{cookieBlocked=true}
        try{localStorage.getItem('relay')}catch{storageBlocked=true}
        let bridge=!!(window.Capacitor||window.androidBridge||window.webkit?.messageHandlers?.bridge);
        parent.postMessage({ready:true,parentBlocked,cookieBlocked,storageBlocked,bridge},'*');
        window.addEventListener('message',()=>document.getElementById('tap').click());
        </script>
        """
        let web = try await open(source)
        let result = try await receipt(web, containing: "ready")
        for field in ["parentBlocked", "cookieBlocked", "storageBlocked"] { XCTAssertTrue(result.contains("\"\(field)\":true"), result) }
        XCTAssertTrue(result.contains("\"bridge\":false"), result)
        let bridge = try await web.evaluateJavaScript("!!(window.Capacitor||window.androidBridge||window.webkit?.messageHandlers?.bridge)") as? Bool
        XCTAssertEqual(bridge, false)
        let cookies = await web.configuration.websiteDataStore.httpCookieStore.allCookies()
        XCTAssertTrue(cookies.isEmpty)
        _ = try await web.evaluateJavaScript("document.querySelector('iframe').contentWindow.postMessage('tap','*')")
        let clicked = try await receipt(web, containing: "clicked")
        XCTAssertTrue(clicked.contains("clicked"))
        web.stopLoading()
    }
    func testPreviewCSPRejectsRemoteResourcesAndCannotNavigateHost() async throws {
        let probe = try PreviewNetworkProbe()
        let target = try await probe.start()
        defer { probe.listener.cancel() }
        // Prove the endpoint is reachable from WebKit before testing restrictions.
        let control = RelayResultContent.webView()
        control.load(URLRequest(url: target))
        for _ in 0..<100 {
            if probe.hits > 0 { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertEqual(probe.hits, 1)
        control.stopLoading()
        probe.hits = 0
        let source = """
        <img src="\(target.absoluteString)" onerror="parent.postMessage('image-blocked','*')">
        <form action="\(target.absoluteString)" method="post" id="form"></form><script>
        window.addEventListener('securitypolicyviolation',event=>parent.postMessage(event.violatedDirective,'*'));
        fetch('\(target.absoluteString)').catch(()=>parent.postMessage('fetch-blocked','*'));
        document.getElementById('form').submit();
        parent.postMessage('form-attempted','*');
        parent.postMessage(window.open('\(target.absoluteString)')===null?'popup-blocked':'popup-opened','*');
        window.addEventListener('message',()=>{location.href='\(target.absoluteString)';parent.postMessage('navigation-attempted','*')});
        try{top.location='\(target.absoluteString)'}catch{parent.postMessage('top-blocked','*')}
        parent.postMessage('loaded','*');
        </script>
        """
        let web = try await open(source)
        let result = try await receipt(web, containing: "fetch-blocked")
        XCTAssertTrue(result.contains("connect-src"), result)
        _ = try await receipt(web, containing: "image-blocked")
        _ = try await receipt(web, containing: "form-attempted")
        _ = try await receipt(web, containing: "popup-blocked")
        _ = try await receipt(web, containing: "top-blocked")
        _ = try await web.evaluateJavaScript("document.querySelector('iframe').contentWindow.postMessage('navigate','*')")
        _ = try await receipt(web, containing: "navigation-attempted")
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(probe.hits, 0, "A generated page reached the network probe")
        XCTAssertEqual(web.url?.absoluteString, "about:blank")
        let changed = try await web.evaluateJavaScript("!!document.body.dataset.bad") as? Bool
        XCTAssertEqual(changed, false)
        web.stopLoading()
    }
    func testStopDestroysPreviewAndRestartCreatesFreshView() {
        let screen = RelayPreviewController(title: "Demo", source: "<p>Hello</p>")
        screen.loadViewIfNeeded()
        let first = screen.preview
        XCTAssertNotNil(first)
        screen.stop()
        XCTAssertNil(screen.preview)
        XCTAssertNil(first?.superview)
        screen.restart()
        XCTAssertNotNil(screen.preview)
        XCTAssertFalse(first === screen.preview)
        screen.stop()
    }
    func testExportPreservesBytesUsesDistinctPathsAndCleansOnlyStaging() throws {
        let bytes = Data([0, 1, 2, 127, 128, 255])
        let parsed = try RelayResultContent.file(name: "旅行.xlsx", base64: bytes.base64EncodedString())
        XCTAssertEqual(bytes, parsed)
        let first = try RelayResultContent.stage(name: "旅行.xlsx", data: parsed)
        let second = try RelayResultContent.stage(name: "旅行.xlsx", data: parsed)
        defer { RelayResultContent.clean(first); RelayResultContent.clean(second) }
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(try Data(contentsOf: first), bytes)
        RelayResultContent.clean(first)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path))
        XCTAssertEqual(try Data(contentsOf: second), bytes)
    }
    func testExportRejectsTraversalInvalidBytesAndOversizedFiles() throws {
        for name in ["", ".", "..", "../secret", "a/b", "a\\b", "bad\nname", String(repeating: "a", count: 241)] {
            XCTAssertThrowsError(try RelayResultContent.file(name: name, base64: "AA=="))
        }
        XCTAssertThrowsError(try RelayResultContent.file(name: "file.bin", base64: "invalid!"))
        let maximum = Data(repeating: 5, count: RelayResultContent.maxBytes)
        XCTAssertEqual(try RelayResultContent.file(name: "max.bin", base64: maximum.base64EncodedString()).count, maximum.count)
        XCTAssertThrowsError(try RelayResultContent.file(name: "large.bin", base64: (maximum + Data([0])).base64EncodedString()))
        XCTAssertEqual(try RelayResultContent.file(name: "empty.txt", base64: "").count, 0)
    }
    func testColdStartCleanupRemovesOnlyOwnedStagingDirectories() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("relay-export-cleanup-test-" + UUID().uuidString)
        let outside = FileManager.default.temporaryDirectory.appendingPathComponent("relay-export-outside-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: outside) }
        let bytes = Data([1, 4, 9, 16])
        let staged = try RelayResultContent.stage(name: "Result.docx", data: bytes, root: root)
        let saved = outside.appendingPathComponent("Result.docx")
        try bytes.write(to: saved)
        let unrelated = root.appendingPathComponent("relay-export-my-files")
        try FileManager.default.createDirectory(at: unrelated, withIntermediateDirectories: true)
        let ordinary = root.appendingPathComponent("relay-export-" + UUID().uuidString)
        try bytes.write(to: ordinary)
        let linked = root.appendingPathComponent("relay-export-" + UUID().uuidString)
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: outside)
        RelayResultContent.cleanAbandoned(root: root)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
        XCTAssertEqual(try Data(contentsOf: ordinary), bytes)
        XCTAssertEqual(try Data(contentsOf: saved), bytes)
        XCTAssertTrue(try linked.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true)
        RelayResultContent.cleanAbandoned(root: root)
        XCTAssertEqual(try Data(contentsOf: saved), bytes)
    }
}

@MainActor
private final class PreviewNetworkProbe {
    let listener: NWListener
    var hits = 0
    init() throws { listener = try NWListener(using: .tcp, on: .any) }
    func start() async throws -> URL {
        listener.newConnectionHandler = { [weak self] connection in
            connection.start(queue: .main)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, _, _ in
                if data != nil { self?.hits += 1 }
                let response = Data("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8)
                connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        return try await withCheckedThrowingContinuation { continuation in
            var finished = false
            listener.stateUpdateHandler = { [weak self] state in
                guard !finished else { return }
                if case .ready = state, let port = self?.listener.port {
                    finished = true
                    continuation.resume(returning: URL(string: "http://127.0.0.1:\(port.rawValue)/probe")!)
                } else if case .failed(let error) = state {
                    finished = true
                    continuation.resume(throwing: error)
                }
            }
            listener.start(queue: .main)
        }
    }
}

final class BackupFileTests: XCTestCase {
    func testLargeEncryptedBackupPreservesBytesAndTransfersCleanupToPicker() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var file: RelayBackupFile? = try RelayBackupFile(root: root)
        var chunk = Data(repeating: 45, count: RelayBackupFile.chunk)
        chunk.replaceSubrange(0..<16, with: Data("RELAY-COMPUTER-1".utf8))
        for index in 0..<12 { try file!.append(offset: Int64(index * chunk.count), base64: chunk.base64EncodedString()) }
        XCTAssertThrowsError(try file!.finish(size: 12))
        let output = try file!.finish(size: Int64(12 * chunk.count)); file = nil
        let data = try Data(contentsOf: output)
        XCTAssertEqual(data.count, 12 * chunk.count)
        for index in 0..<12 { XCTAssertEqual(data.subdata(in: (index * chunk.count)..<((index + 1) * chunk.count)), chunk) }
        RelayResultContent.clean(output)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).count, 0)
        XCTAssertEqual(RelayBackupFile.maximum, 8658257232)
    }
    func testBadAndCancelledChunksCannotLeaveStagingBehind() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var file: RelayBackupFile? = try RelayBackupFile(root: root)
        XCTAssertThrowsError(try file!.append(offset: 0, base64: Data(repeating: 0, count: 60).base64EncodedString()))
        let data = Data(("RELAY-COMPUTER-1" + String(repeating: "x", count: 60)).utf8)
        try file!.append(offset: 0, base64: data.base64EncodedString())
        XCTAssertThrowsError(try file!.append(offset: 0, base64: data.base64EncodedString()))
        XCTAssertThrowsError(try file!.append(offset: Int64(data.count), base64: Data(repeating: 0, count: RelayBackupFile.chunk + 1).base64EncodedString()))
        file = nil
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).count, 0)
    }
}


final class ConnectionCopyTests: XCTestCase {
    func testSupportedDeviceLanguagesAndExplicitWorkspaceChoice() {
        XCTAssertEqual(RelayConnectionCopy.locale(nil, languages: ["fr-FR", "zh-Hant-HK", "en-US"]), "zh-TW")
        XCTAssertEqual(RelayConnectionCopy.locale(nil, languages: ["en-GB", "zh-CN"]), "en")
        XCTAssertEqual(RelayConnectionCopy.locale(nil, languages: ["zh-Hans-TW"]), "zh-CN")
        XCTAssertEqual(RelayConnectionCopy.locale(nil, languages: ["zh_HK"]), "zh-TW")
        XCTAssertEqual(RelayConnectionCopy.locale(nil, languages: ["fr"]), "en")
        XCTAssertEqual(RelayConnectionCopy.locale("zh-CN", languages: ["en-US"]), "zh-CN")
        XCTAssertEqual(RelayConnectionCopy.locale("https://example.invalid", languages: ["zh-Hant"]), "zh-TW")
    }
    func testBlockedBrowserPortsStayInTheConnectionForm() throws {
        for port in RelayBridgeViewController.blockedWebPorts {
            XCTAssertThrowsError(try RelayBridgeViewController.validatedServer("https://127.0.0.1:\(port)/"))
        }
        XCTAssertEqual(try RelayBridgeViewController.validatedServer("https://relay.example:8443/"), "https://relay.example:8443/")
    }
    func testSharedBundledCopyAndFallback() {
        XCTAssertEqual(RelayConnectionCopy.text("Connect", locale: "zh-CN"), "连接")
        XCTAssertEqual(RelayConnectionCopy.text("Connect", locale: "zh-TW"), "連接")
        XCTAssertEqual(RelayConnectionCopy.text("Connect", locale: "en"), "Connect")
        XCTAssertEqual(RelayConnectionCopy.text("Unknown key", locale: "zh-CN"), "Unknown key")
    }
}
