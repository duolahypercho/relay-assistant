import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        for context in connectionOptions.urlContexts { RelayTemplateLinks.receive(context.url) }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = RelayBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts { RelayTemplateLinks.receive(context.url) }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

// The address is stored on the device. Authentication stays in the chosen
// server's cookie store; it is never passed through the connection bridge.
final class RelayBridgeViewController: CAPBridgeViewController {
    static let preference = "relay-server"
    // A connection grant survives only this in-process view replacement. The
    // saved preference remains the bare origin; the web entry consumes the link.
    static var pendingConnectionLink: String?

    static func connectionInput(_ value: String) throws -> (server: String, link: String?) {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var url = URLComponents(string: text), let fragment = url.percentEncodedFragment else {
            return (try validatedServer(text), nil)
        }
        guard url.scheme?.lowercased() == "https",
              fragment.range(of: "^connect=[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw connectionError() }
        url.fragment = nil
        let server = try validatedServer(url.string ?? "")
        return (server, server + "#" + fragment)
    }

    // Keep aligned with the browser port rules in shared/web-ports.mjs.
    static let blockedWebPorts: Set<Int> = [0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]

    static func validatedServer(_ value: String) throws -> String {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return "" }
        guard var url = URLComponents(string: text),
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            throw connectionError()
        }
        if let port = url.port, Self.blockedWebPorts.contains(port) { throw connectionError("This address uses a port the app cannot open. Check your server’s web address.") }
        var allowed = url.scheme?.lowercased() == "https"
        #if DEBUG
        if url.scheme?.lowercased() == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) { allowed = true }
        #endif
        guard allowed, url.port == nil || (1...65535).contains(url.port!) else { throw connectionError() }
        url.path = "/"
        guard let address = url.url?.absoluteString else { throw connectionError() }
        return address
    }

    static func connectionError(_ message: String = "Enter your server’s HTTPS address, without a path, password or query.") -> NSError {
        NSError(domain: "RelayConnection", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        if let saved = UserDefaults.standard.string(forKey: Self.preference),
           let address = try? Self.validatedServer(saved) {
            descriptor.serverURL = address.isEmpty ? nil : address
        }
        descriptor.errorPath = "native-connection.html"
        if let link = Self.pendingConnectionLink {
            Self.pendingConnectionLink = nil
            descriptor.serverURL = link
        }
        return descriptor
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(RelayConnectionPlugin())
        bridge?.registerPluginInstance(RelayResultsPlugin())
        bridge?.registerPluginInstance(RelaySharesPlugin())
        #if DEBUG
        installShareTestSource()
        #endif
    }

    var connectedServer: String {
        let saved = UserDefaults.standard.string(forKey: Self.preference)
        return saved ?? (bridge?.config.serverURL.scheme == "capacitor" ? "" : bridge?.config.serverURL.absoluteString ?? "")
    }

    private weak var connectionAlert: UIAlertController?
    private var connectionLocale = "en"
    private func connectionText(_ key: String) -> String { RelayConnectionCopy.text(key, locale: connectionLocale) }

    @objc private func validateConnectionField(_ field: UITextField) {
        guard let alert = connectionAlert else { return }
        let value = field.text ?? ""
        var valid = false
        var errorMessage = "Enter your server’s HTTPS address, without a path, password or query."
        do { valid = !(try Self.connectionInput(value)).server.isEmpty }
        catch { errorMessage = error.localizedDescription }
        alert.actions.last?.isEnabled = valid
        let description = connectionText("Paste a connection link from your other device, or enter your server’s HTTPS address. A link lets you join without copying the owner key.")
        // Keep the field and its text in the original form. No second error
        // alert, dismissal or re-entry is needed for a malformed pasted link.
        alert.message = value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || valid
            ? description
            : description + "\n\n" + connectionText(errorMessage)
    }

    func showConnection(locale: String? = nil) {
        guard presentedViewController == nil else { return }
        connectionLocale = RelayConnectionCopy.locale(locale)
        let alert = UIAlertController(title: connectionText("Connect your devices"), message: nil, preferredStyle: .alert)
        connectionAlert = alert
        alert.addTextField { field in
            field.placeholder = "https://relay.example.com"
            field.text = self.connectedServer
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.clearButtonMode = .whileEditing
            field.accessibilityIdentifier = "Relay server address"
            field.accessibilityLabel = self.connectionText("Relay server address")
            field.addTarget(self, action: #selector(self.validateConnectionField(_:)), for: .editingChanged)
        }
        alert.addAction(UIAlertAction(title: connectionText("Cancel"), style: .cancel))
        alert.addAction(UIAlertAction(title: connectionText("Use sample on this device"), style: .default) { _ in self.connect("") })
        alert.addAction(UIAlertAction(title: connectionText("Connect"), style: .default) { [weak alert] _ in
            guard let value = try? Self.connectionInput(alert?.textFields?.first?.text ?? ""), !value.server.isEmpty else { return }
            Self.pendingConnectionLink = value.link
            self.connect(value.server)
        })
        if let field = alert.textFields?.first { validateConnectionField(field) }
        present(alert, animated: true)
    }

    private func connect(_ address: String) {
        UserDefaults.standard.set(address, forKey: Self.preference)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            self.view.window?.rootViewController = RelayBridgeViewController()
        }
    }
}

@objc(RelayConnectionPlugin)
final class RelayConnectionPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "RelayConnectionPlugin"
    let jsName = "RelayConnection"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSignIn", returnType: CAPPluginReturnPromise)
    ]
    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["url": (self.bridge?.viewController as? RelayBridgeViewController)?.connectedServer ?? ""])
        }
    }
    private func port(_ url: URLComponents) -> Int { url.port ?? (url.scheme == "https" ? 443 : 80) }
    @objc func openAppSignIn(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController as? RelayBridgeViewController,
                  let root = URLComponents(string: controller.connectedServer),
                  let current = self.bridge?.webView?.url.flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false) }),
                  let value = call.getString("url"), let target = URLComponents(string: value), let url = target.url,
                  current.scheme == root.scheme, current.host == root.host, self.port(current) == self.port(root), current.path == "/",
                  target.scheme == root.scheme, target.host == root.host, self.port(target) == self.port(root),
                  target.user == nil, target.password == nil, target.fragment == nil,
                  ["/api/connectors/oauth/open", "/api/models/oauth/open"].contains(target.path), target.queryItems?.count == 2,
                  let id = target.queryItems?.first(where: { $0.name == "id" })?.value, UUID(uuidString: id) != nil,
                  let ticket = target.queryItems?.first(where: { $0.name == "ticket" })?.value,
                  ticket.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
                call.reject("Open app sign-in from the Relay workspace.")
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("The sign-in browser could not open.") }
            }
        }
    }
    @objc func show(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController as? RelayBridgeViewController else {
                call.reject("Connection screen unavailable")
                return
            }
            controller.showConnection(locale: call.getString("locale"))
            call.resolve()
        }
    }
}

// Original shared copy, read only from the bundled assets. Remote text never
// supplies native labels, and addresses/connection grants are never translated.
enum RelayConnectionCopy {
    static func locale(_ explicit: String? = nil, languages: [String] = Locale.preferredLanguages) -> String {
        if let explicit, ["en", "zh-CN", "zh-TW"].contains(explicit) { return explicit }
        for language in languages {
            let parts = language.lowercased().replacingOccurrences(of: "_", with: "-").split(separator: "-").map(String.init)
            if parts.first == "en" { return "en" }
            if parts.first == "zh" {
                if parts.contains("hans") { return "zh-CN" }
                if parts.contains("hant") { return "zh-TW" }
                return parts.contains(where: { ["tw", "hk", "mo"].contains($0) }) ? "zh-TW" : "zh-CN"
            }
        }
        return "en"
    }
    private static let copy: [String: [String]] = {
        guard let url = Bundle.main.url(forResource: "native-connection-language", withExtension: "json", subdirectory: "public"),
              let data = try? Data(contentsOf: url),
              let result = try? JSONDecoder().decode([String: [String]].self, from: data) else { return [:] }
        return result
    }()
    static func text(_ key: String, locale: String) -> String {
        let index = locale == "zh-CN" ? 0 : locale == "zh-TW" ? 1 : -1
        guard index >= 0, let entry = copy[key], entry.count == 2 else { return key }
        return entry[index]
    }
}
