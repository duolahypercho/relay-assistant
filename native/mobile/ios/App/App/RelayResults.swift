import UIKit
import WebKit
import Capacitor

// This view deliberately has no Capacitor bridge, shared website data or URL handler.
// Generated code runs in an opaque, offline frame inside a disposable web view.
enum RelayResultContent {
    static let maxBytes = 8 * 1024 * 1024
    static func error(_ message: String) -> NSError {
        NSError(domain: "RelayResults", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    static func file(name: String, base64: String) throws -> Data {
        guard !name.isEmpty, name.utf8.count <= 240, name != ".", name != "..",
              !name.contains("/"), !name.contains("\\"),
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              base64.utf8.count <= ((maxBytes + 2) / 3) * 4,
              let data = Data(base64Encoded: base64), data.count <= maxBytes else {
            throw error("Choose a valid file of 8 MB or less.")
        }
        return data
    }
    static func stage(name: String, data: Data, root: URL = FileManager.default.temporaryDirectory) throws -> URL {
        let directory = root.appendingPathComponent("relay-export-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(name)
        do { try data.write(to: url, options: .atomic) }
        catch { try? FileManager.default.removeItem(at: directory); throw error }
        return url
    }
    static func clean(_ url: URL?) {
        if let url = url { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    }
    static func cleanAbandoned(root: URL = FileManager.default.temporaryDirectory) {
        // A force-quit does not run delegates or deinit. Only our exact UUID
        // staging directories belong to this cleanup; exported Files live elsewhere.
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isSymbolicLinkKey]
        guard let entries = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: Array(keys)) else { return }
        for entry in entries {
            let name = entry.lastPathComponent
            guard name.hasPrefix("relay-export-") else { continue }
            let suffix = String(name.dropFirst("relay-export-".count))
            guard suffix.count == 36, UUID(uuidString: suffix) != nil,
                  let values = try? entry.resourceValues(forKeys: keys),
                  values.isDirectory == true, values.isSymbolicLink != true else { continue }
            try? FileManager.default.removeItem(at: entry)
        }
    }
    static func escaped(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
    static func page(source: String) -> String {
        let policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        let content = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body>\(source)</body></html>"
        return """
        <!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;background:white}iframe{display:block}</style></head><body><iframe title="Result preview" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" srcdoc="\(escaped(content))"></iframe></body></html>
        """
    }
    static func webView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController = WKUserContentController()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.allowsInlineMediaPlayback = false
        return WKWebView(frame: .zero, configuration: config)
    }
    static func load(_ view: WKWebView, source: String, shouldLoad: @escaping () -> Bool = { true }, completion: @escaping (Error?) -> Void) {
        // In addition to CSP, block remote resources at WebKit's content layer.
        let rules = #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}}]"#
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "relay-offline-results-v1", encodedContentRuleList: rules) { list, error in
            guard let list = list else { completion(error ?? self.error("Preview protection is unavailable.")); return }
            guard shouldLoad() else { completion(nil); return }
            view.configuration.userContentController.add(list)
            view.loadHTMLString(page(source: source), baseURL: nil)
            completion(nil)
        }
    }
}

final class RelayPreviewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    let source: String
    private(set) var preview: WKWebView?
    private let message = UILabel()
    private var revision = 0
    init(title: String, source: String) {
        self.source = source
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }
    required init?(coder: NSCoder) { fatalError("Use init(title:source:)") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Back", style: .plain, target: self, action: #selector(close))
        navigationItem.rightBarButtonItems = [
            UIBarButtonItem(title: "Restart", style: .plain, target: self, action: #selector(restart)),
            UIBarButtonItem(title: "Stop", style: .plain, target: self, action: #selector(stop))
        ]
        message.textAlignment = .center
        message.numberOfLines = 0
        message.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(message)
        NSLayoutConstraint.activate([message.centerYAnchor.constraint(equalTo: view.centerYAnchor), message.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24), message.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24)])
        restart()
    }
    @objc func stop() {
        revision += 1
        preview?.stopLoading()
        preview?.navigationDelegate = nil
        preview?.uiDelegate = nil
        preview?.removeFromSuperview()
        preview = nil
        message.text = "Preview stopped. Tap Restart to open it again."
    }
    @objc func restart() {
        stop()
        let token = revision
        message.text = "Opening preview…"
        let web = RelayResultContent.webView()
        web.navigationDelegate = self
        web.uiDelegate = self
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor), web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        preview = web
        RelayResultContent.load(web, source: source, shouldLoad: { [weak self] in self?.revision == token }) { [weak self, weak web] error in
            guard let self = self else { return }
            guard token == self.revision else { web?.stopLoading(); return }
            if let error = error { self.stop(); self.message.text = error.localizedDescription }
        }
    }
    @objc func close() { stop(); dismiss(animated: true) }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || navigationController?.isBeingDismissed == true { stop() }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url?.absoluteString ?? ""
        decisionHandler(["about:blank", "about:srcdoc"].contains(url) ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) { completionHandler() }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) { completionHandler(false) }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) { completionHandler(nil) }
}

// Bounded, encrypted backup staging. The web layer supplies no filesystem paths.
final class RelayBackupFile {
    static let chunk = 1024 * 1024
    static let maximum = Int64(8) * 1024 * 1024 * 1024 + 65 * 1024 * 1024 + 8257 * 20 + 60
    let id = UUID().uuidString
    let url: URL
    private var handle: FileHandle?
    private(set) var bytes: Int64 = 0
    private var released = false
    init(root: URL = FileManager.default.temporaryDirectory) throws {
        url = try RelayResultContent.stage(name: "Relay-computer.relaybackup", data: Data(), root: root)
        do { handle = try FileHandle(forWritingTo: url) }
        catch { RelayResultContent.clean(url); throw error }
    }
    func append(offset: Int64, base64: String) throws {
        guard let handle = handle, offset == bytes, base64.utf8.count <= ((Self.chunk + 2) / 3) * 4,
              let data = Data(base64Encoded: base64), !data.isEmpty, data.count <= Self.chunk,
              data.base64EncodedString() == base64, bytes + Int64(data.count) <= Self.maximum,
              bytes != 0 || String(data: data.prefix(16), encoding: .utf8) == "RELAY-COMPUTER-1" else {
            throw RelayResultContent.error("The backup transfer is incomplete or out of order.")
        }
        try handle.write(contentsOf: data); bytes += Int64(data.count)
    }
    func finish(size: Int64) throws -> URL {
        guard let handle = handle, size == bytes, bytes >= 60 else { throw RelayResultContent.error("Wait for the complete backup before saving.") }
        try handle.synchronize(); try handle.close(); self.handle = nil; released = true
        return url
    }
    deinit { try? handle?.close(); if !released { RelayResultContent.clean(url) } }
}

@objc(RelayResultsPlugin)
final class RelayResultsPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    let identifier = "RelayResultsPlugin"
    let jsName = "RelayResults"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "preview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginBackup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appendBackup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveBackup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelBackup", returnType: CAPPluginReturnPromise)
    ]
    private var pendingSave: CAPPluginCall?
    private var staged: URL?
    private var backup: RelayBackupFile?
    override func load() {
        RelayResultContent.cleanAbandoned()
    }
    @objc func preview(_ call: CAPPluginCall) {
        guard let source = call.getString("source"), source.utf16.count <= 200000 else { call.reject("This preview is too large."); return }
        let title = String((call.getString("title") ?? "Preview").prefix(120))
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController, host.presentedViewController == nil, self.pendingSave == nil, self.backup == nil else { call.reject("Close the current screen first."); return }
            let navigation = UINavigationController(rootViewController: RelayPreviewController(title: title, source: source))
            navigation.modalPresentationStyle = .fullScreen
            host.present(navigation, animated: true) { call.resolve() }
        }
    }
    @objc func save(_ call: CAPPluginCall) {
        do {
            let name = call.getString("name") ?? ""
            let data = try RelayResultContent.file(name: name, base64: call.getString("base64") ?? "!")
            DispatchQueue.main.async {
                guard let host = self.bridge?.viewController, host.presentedViewController == nil, self.pendingSave == nil, self.backup == nil else { call.reject("Close the current screen first."); return }
                do {
                    let url = try RelayResultContent.stage(name: name, data: data)
                    self.staged = url
                    self.pendingSave = call
                    let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
                    picker.delegate = self
                    host.present(picker, animated: true)
                } catch { call.reject("The file could not be prepared for saving.") }
            }
        } catch { call.reject(error.localizedDescription) }
    }
    @objc func beginBackup(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pendingSave == nil, self.backup == nil, self.bridge?.viewController?.presentedViewController == nil else { call.reject("Finish the current save first."); return }
            do { let file = try RelayBackupFile(); self.backup = file; call.resolve(["id": file.id]) }
            catch { call.reject("The backup could not be prepared on this device.") }
        }
    }
    @objc func appendBackup(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let file = self.backup, call.getString("id") == file.id,
                  let offset = call.getDouble("offset"), offset.isFinite, offset >= 0, offset <= Double(RelayBackupFile.maximum), offset.rounded() == offset,
                  let data = call.getString("base64") else { call.reject("This backup save expired."); return }
            do { try file.append(offset: Int64(offset), base64: data); call.resolve(["bytes": file.bytes]) }
            catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func saveBackup(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let file = self.backup, call.getString("id") == file.id, self.pendingSave == nil,
                  let size = call.getDouble("size"), size.isFinite, size >= 60, size <= Double(RelayBackupFile.maximum), size.rounded() == size,
                  let host = self.bridge?.viewController, host.presentedViewController == nil else { call.reject("Finish the current save first."); return }
            do {
                self.staged = try file.finish(size: Int64(size)); self.backup = nil; self.pendingSave = call
                let picker = UIDocumentPickerViewController(forExporting: [self.staged!], asCopy: true)
                picker.delegate = self; host.present(picker, animated: true)
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func cancelBackup(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let file = self.backup, call.getString("id") == file.id else { call.reject("This backup save expired."); return }
            self.backup = nil; call.resolve(["status": "cancelled"])
        }
    }
    private func finish(_ status: String) {
        let call = pendingSave
        pendingSave = nil
        RelayResultContent.clean(staged)
        staged = nil
        call?.resolve(["status": status])
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finish(urls.isEmpty ? "cancelled" : "saved") }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish("cancelled") }
    deinit { RelayResultContent.clean(staged) }
}
