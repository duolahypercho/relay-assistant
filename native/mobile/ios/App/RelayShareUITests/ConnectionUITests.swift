import XCTest
import UIKit

final class ConnectionUITests: XCTestCase {

    func testEmailClarificationRecovery() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run isolated email clarification acceptance.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<12 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY - 10 : app.frame.maxY - 95
                if element.isHittable && element.frame.minY > 130 && element.frame.maxY < bottom { return }
                let above = element.frame.minY < 130
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: above ? 0.33 : 0.77)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: above ? 0.77 : 0.33)))
            }
        }
        func capture(_ name: String) { let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; self.add(shot) }
        let key = app.secureTextFields["Server access key"]; reveal(key); key.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10)); key.tap(); key.typeText("native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        request("/start")
        let answer = app.textFields["Your own answer"]
        XCTAssertTrue(answer.waitForExistence(timeout: 30), app.debugDescription)
        composer.tap(); composer.typeText("Keep my next thought")
        reveal(answer); answer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10)); answer.typeText("friend@")
        XCTAssertEqual(answer.value as? String, "friend@"); capture("iPhone unfinished recipient answer")
        app.buttons["More"].tap(); app.buttons["Files"].tap(); app.buttons["Back to chat"].tap()
        XCTAssertTrue(answer.waitForExistence(timeout: 30)); XCTAssertEqual(answer.value as? String, "friend@")
        request("/pending")
        app.terminate(); app.launch()
        XCTAssertTrue(answer.waitForExistence(timeout: 30)); XCTAssertEqual(answer.value as? String, "friend@")
        XCTAssertEqual(composer.value as? String, "Keep my next thought")
        request("/pending"); reveal(answer); capture("iPhone recovered recipient answer")
        answer.tap(); answer.typeText("example.test")
        XCTAssertEqual(answer.value as? String, "friend@example.test")
        let send = app.buttons["Send answer"]; reveal(send); send.tap()
        let subject = app.staticTexts["Tomorrow at the workshop"]
        XCTAssertTrue(subject.waitForExistence(timeout: 30), app.debugDescription)
        request("/verify"); reveal(subject); capture("iPhone exact unsent email review")
        XCTAssertEqual(composer.value as? String, "Keep my next thought")
        XCTAssertFalse(app.alerts.firstMatch.exists)
        app.terminate(); app.launch()
        XCTAssertTrue(subject.waitForExistence(timeout: 30)); XCTAssertEqual(composer.value as? String, "Keep my next thought")
        XCTAssertFalse(answer.exists); request("/verify")
    }

    func testMissingComputerRecovery() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run isolated computer recovery acceptance.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 45)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 45), app.debugDescription)
            for _ in 0..<14 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY - 10 : app.frame.maxY - 95
                if element.isHittable && element.frame.minY > 145 && element.frame.maxY < bottom { return }
                let above = element.frame.minY < 145
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: above ? 0.33 : 0.78)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: above ? 0.78 : 0.33)))
            }
        }
        func tap(_ element: XCUIElement) { reveal(element); element.tap() }
        func capture(_ name: String) { let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; self.add(shot) }
        let key = app.secureTextFields["Server access key"]; reveal(key); key.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10)); key.tap(); key.typeText("native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]; XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        composer.tap(); composer.typeText("Keep my computer recovery thought")
        request("/lose")
        app.buttons["More"].tap(); app.buttons["Computer"].tap()
        let missing = app.staticTexts["Your saved workspace could not be found."]
        XCTAssertTrue(missing.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertFalse(app.buttons["Start computer"].exists)
        reveal(app.buttons["Import backup"]); capture("iPhone missing computer recovery")
        tap(app.buttons["Start a new empty workspace"])
        XCTAssertTrue(app.staticTexts["Start a new empty workspace?"].waitForExistence(timeout: 10)); tap(app.buttons["Not now"]); request("/cancelled")
        let restore = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Review restore point ")).firstMatch
        tap(restore); tap(app.buttons["Restore workspace"])
        XCTAssertTrue(app.buttons["Give back to Relay"].waitForExistence(timeout: 45), app.debugDescription); request("/restored")
        request("/lose")
        XCTAssertTrue(missing.waitForExistence(timeout: 30)); tap(app.buttons["Start a new empty workspace"]); tap(app.buttons["Start empty workspace"])
        XCTAssertTrue(app.buttons["Give back to Relay"].waitForExistence(timeout: 45), app.debugDescription); request("/fresh")
        capture("iPhone new empty computer")
        tap(app.buttons["Back to chat"]); XCTAssertTrue(composer.waitForExistence(timeout: 30)); XCTAssertEqual(composer.value as? String,"Keep my computer recovery thought")
        app.terminate(); app.launch(); XCTAssertTrue(composer.waitForExistence(timeout: 30)); XCTAssertEqual(composer.value as? String,"Keep my computer recovery thought")
        request("/verify")
        request("/lose")
        XCTAssertTrue(app.buttons["Recover computer"].waitForExistence(timeout: 30))
        tap(app.buttons["Recover computer"]); reveal(app.buttons["Import backup"])
        tap(app.buttons["Back to chat"])
        XCTAssertEqual(composer.value as? String, "Keep my computer recovery thought")
        tap(app.buttons["Send message and continue chatting"])
        XCTAssertTrue(app.staticTexts["Your devices are sharing this conversation."].waitForExistence(timeout: 30), app.debugDescription)
        request("/chat"); capture("iPhone chat continues without replacing lost computer")
    }

    func testAssistantTemplateLinks() throws {
        guard #available(iOS 16.4, *) else { throw XCTSkip("Native URL-opening acceptance requires iOS 16.4.") }
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run isolated template link acceptance.") }
        @discardableResult func request(_ path: String) -> String {
            var value = ""
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { bytes, response, error in
                value = String(data: bytes ?? Data(), encoding: .utf8) ?? ""
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
            return value
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<12 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY - 10 : app.frame.maxY - 95
                if element.isHittable && element.frame.minY > 130 && element.frame.maxY < bottom { return }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.77)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.32)))
            }
        }
        func capture(_ name: String) { let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; self.add(shot) }
        let key = app.secureTextFields["Server access key"]; reveal(key); key.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        key.tap(); key.typeText("native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["More"].tap(); app.buttons["Settings"].tap()
        let data = app.buttons["Data & devices"]; reveal(data); data.tap()
        app.buttons["Connect your devices"].tap()
        let connect = app.alerts["Connect your devices"]; XCTAssertTrue(connect.waitForExistence(timeout: 10)); connect.buttons["Connect"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30)); composer.tap(); composer.typeText("Keep my template thought")
        request("/saved")
        // Real operating-system dispatch while the app is terminated.
        app.terminate(); app.launchArguments = []; app.open(URL(string: request("/open"))!)
        let add = app.buttons["Add assistant"]
        reveal(add); XCTAssertFalse(app.textFields["Template link"].exists); XCTAssertFalse(app.buttons["Load template"].exists)
        capture("iPhone template review"); request("/pending")
        app.terminate(); app.launch(); reveal(add); request("/pending")
        add.tap(); XCTAssertTrue(app.textViews["Message Aster travel kit"].waitForExistence(timeout: 30), app.debugDescription)
        request("/added")
        app.open(URL(string: request("/second"))!); XCTAssertTrue(app.staticTexts["Aster second kit"].firstMatch.waitForExistence(timeout: 30), app.debugDescription)
        app.open(URL(string: request("/open"))!); XCTAssertTrue(app.staticTexts["Aster travel kit"].firstMatch.waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["All assistants"].tap(); request("/dismissed")
        app.open(URL(string: request("/revoked"))!)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "This template is unavailable")).firstMatch.waitForExistence(timeout: 30), app.debugDescription)
        capture("iPhone revoked template"); app.buttons["All assistants"].tap()
        app.buttons["Main chat"].tap(); XCTAssertTrue(composer.waitForExistence(timeout: 30)); XCTAssertEqual(composer.value as? String, "Keep my template thought")
        app.terminate(); app.launch(); XCTAssertTrue(composer.waitForExistence(timeout: 30)); XCTAssertEqual(composer.value as? String, "Keep my template thought")
        request("/verify")
    }

    func testOfficeComputerControls() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run isolated office acceptance.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement, down: Bool = false) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<12 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY - 10 : app.frame.maxY - 95
                if element.isHittable && element.frame.minY > 150 && element.frame.maxY < bottom { return }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: down ? 0.35 : 0.75)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: down ? 0.75 : 0.32)))
            }
        }
        func fill(_ field: XCUIElement, _ text: String) { reveal(field); field.tap(); field.typeText(text) }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["More"].tap(); app.buttons["Settings"].tap()
        let data = app.buttons["Data & devices"]; reveal(data); data.tap()
        app.buttons["Connect your devices"].tap()
        let connect = app.alerts["Connect your devices"]
        XCTAssertTrue(connect.waitForExistence(timeout: 10)); connect.buttons["Connect"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30))
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my office draft")
        app.buttons["More"].tap(); app.buttons["Computer"].tap()
        let files = app.buttons["Files"].firstMatch; reveal(files); files.tap()
        let open = app.buttons["Open Welcome.docx"]; reveal(open); request("/files"); open.tap()
        request("/opened")
        let keyboard = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Show computer keyboard")).firstMatch
        reveal(keyboard, down: true); keyboard.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        let direct = app.textViews["Type directly on the computer"]
        XCTAssertTrue(direct.waitForExistence(timeout: 10)); direct.typeText("\nMade on my iPhone.")
        let delivered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons["Give back to Relay"])
        XCTAssertEqual(XCTWaiter.wait(for: [delivered], timeout: 20), .completed)
        request("/typed")
        let done = app.buttons["Done"]; reveal(done); done.tap()
        let slides = app.buttons["Slides"]; reveal(slides); slides.tap(); request("/slides")
        let back = app.buttons["Back to chat"]; reveal(back, down: true); back.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30)); XCTAssertEqual(composer.value as? String, "Keep my office draft")
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30)); XCTAssertEqual(composer.value as? String, "Keep my office draft")
        request("/verify")
    }


    func testConnectionLanguageAndInlineValidation() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        let cases: [(String, String, String, String, String, String, String, String, String)] = [
            ("zh-Hans", "zh_CN", "设置", "数据与设备", "连接你的设备", "连接", "取消", "重新连接吧。", "更换服务器"),
            ("zh-Hant", "zh_TW", "設定", "資料與裝置", "連接你的裝置", "連接", "取消", "重新連接吧。", "更換伺服器"),
            ("en", "en_US", "Settings", "Data & devices", "Connect your devices", "Connect", "Cancel", "Let’s reconnect.", "Change server")
        ]
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<10 {
                if element.isHittable && element.frame.maxY < app.frame.maxY - 95 { return }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.8)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.3)))
            }
        }
        func replace(_ field: XCUIElement, _ value: String) {
            field.tap()
            if field.buttons.firstMatch.exists { field.buttons.firstMatch.tap() }
            field.typeText(value)
            XCTAssertEqual(field.value as? String, value)
        }
        func capture(_ name: String) { let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot) }
        for (language, region, settings, data, title, connect, cancel, recovery, change) in cases {
            app.launchArguments = ["-AppleLanguages", "(\(language))", "-AppleLocale", region]
            app.launch()
            let more = app.buttons[language == "en" ? "More" : "更多"]
            if !more.waitForExistence(timeout: 5) {
                XCTAssertTrue(app.staticTexts[recovery].waitForExistence(timeout: 30), app.debugDescription)
                app.buttons[change].tap()
                let sample = language == "en" ? "Use sample on this device" : language == "zh-Hans" ? "在此设备上体验示例" : "在此裝置上體驗範例"
                app.alerts[title].buttons[sample].tap()
            }
            XCTAssertTrue(more.waitForExistence(timeout: 30), app.debugDescription)
            more.tap(); app.buttons[settings].tap(); reveal(app.buttons[data]); app.buttons[data].tap()
            let open = app.buttons[title].firstMatch; reveal(open); open.tap()
            let dialog = app.alerts[title]
            XCTAssertTrue(dialog.waitForExistence(timeout: 10), app.debugDescription)
            let field = dialog.textFields["Relay server address"]
            let invalid = "https://relay.example/private?key=synthetic"
            replace(field, invalid)
            XCTAssertFalse(dialog.buttons[connect].isEnabled)
            XCTAssertEqual(field.value as? String, invalid)
            XCTAssertEqual(app.alerts.count, 1)
            capture("connection-\(language)-inline-error")
            replace(field, "https://127.0.0.1:9/")
            XCTAssertFalse(dialog.buttons[connect].isEnabled)
            XCTAssertEqual(app.alerts.count, 1)
            // Only local unreachable loopback is actually navigated. The synthetic
            // connection grant checks parsing without contacting any external host.
            let link = "https://relay.example/#connect=" + String(repeating: "a", count: 43)
            replace(field, link)
            XCTAssertTrue(dialog.buttons[connect].isEnabled)
            XCTAssertEqual(field.value as? String, link)
            replace(field, "https://127.0.0.1:59998/")
            XCTAssertTrue(dialog.buttons[connect].isEnabled)
            dialog.buttons[connect].tap()
            XCTAssertTrue(app.staticTexts[recovery].waitForExistence(timeout: 35), app.debugDescription)
            XCTAssertTrue(app.staticTexts["https://127.0.0.1:59998/"].exists)
            capture("connection-\(language)-offline")
            app.terminate()
            app.launchArguments = ["-AppleLanguages", "(\(language))", "-AppleLocale", region]
            app.launch()
            XCTAssertTrue(app.staticTexts[recovery].waitForExistence(timeout: 35), app.debugDescription)
            app.buttons[change].tap()
            XCTAssertTrue(dialog.waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertEqual(field.value as? String, "https://127.0.0.1:59998/")
            dialog.buttons[cancel].tap()
            XCTAssertTrue(app.staticTexts[recovery].exists)
            app.terminate()
        }
    }


    func testComputerBackupControls() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated backup controls fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            var r = URLRequest(url: URL(string: control + path)!); r.timeoutInterval = 120
            URLSession.shared.dataTask(with: r) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 130)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 120), app.debugDescription)
            for _ in 0..<12 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY - 12 : app.frame.maxY - 105
                if element.isHittable && element.frame.minY >= 145 && element.frame.maxY <= bottom { return }
                let above = element.frame.minY < 145
                app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: app.frame.maxX - 18, dy: above ? 165 : bottom - 20)).press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: app.frame.maxX - 18, dy: above ? bottom - 20 : 165)))
            }
        }
        func tap(_ label: String) { let element = app.buttons[label].firstMatch; reveal(element); element.tap() }
        func fill(_ element: XCUIElement, _ value: String) { reveal(element); element.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }; element.typeText(value) }
        func capture(_ name: String) { let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot) }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my native backup draft")
        tap("More"); tap("Computer"); tap("Restore points"); tap("Save backup to a file")
        fill(app.secureTextFields["New backup password"], "synthetic native backup password")
        fill(app.secureTextFields["Repeat password"], "synthetic native backup password")
        tap("Save backup")
        // WebKit can consume the first tap while dismissing the secure-input keyboard.
        if app.buttons["Save backup"].firstMatch.waitForExistence(timeout: 2) { tap("Save backup") }
        let cancel = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Cancel")).firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 120), app.debugDescription); capture("backup-native-save-picker"); request("/picker")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.095)).press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.90)))
        XCTAssertTrue(app.staticTexts["Save cancelled. Your backup is ready if you want to try again."].waitForExistence(timeout: 25), app.debugDescription); request("/cancelled")
        tap("Save file"); XCTAssertTrue(cancel.waitForExistence(timeout: 120), app.debugDescription)
        if app.buttons["Save"].exists { app.buttons["Save"].tap() }
        else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.875, dy: 0.126)).tap() }
        XCTAssertTrue(app.staticTexts["Backup saved. Keep its password somewhere safe."].waitForExistence(timeout: 60), app.debugDescription); request("/saved"); capture("backup-native-saved")
        tap("Back to restore points"); tap("Import backup")
        fill(app.secureTextFields["Backup password"], "synthetic native backup password")
        let file = app.buttons["Backup file"].firstMatch
        reveal(file); file.tap()
        if app.buttons["Choose File"].waitForExistence(timeout: 3) { app.buttons["Choose File"].tap() }
        let chosen = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Relay-computer")).firstMatch
        XCTAssertTrue(chosen.waitForExistence(timeout: 25), app.debugDescription); capture("backup-native-import-picker"); chosen.tap()
        tap("Import & review")
        XCTAssertTrue(app.buttons["Restore workspace"].waitForExistence(timeout: 120), app.debugDescription); request("/review"); capture("backup-native-restore-review")
        tap("Restore workspace")
        XCTAssertTrue(app.staticTexts["Your workspace is restored. Check your work, then give control back to Relay."].waitForExistence(timeout: 120), app.debugDescription); request("/restored")
        tap("Back to chat"); XCTAssertEqual(composer.value as? String, "Keep my native backup draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription); XCTAssertEqual(composer.value as? String, "Keep my native backup draft"); request("/verify")
    }

    func testPhoneTouchTargets() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", ""]; app.launch()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        func target(_ name: String) -> XCUIElement {
            let control = app.descendants(matching: .any).matching(identifier: name).firstMatch
            XCTAssertTrue(control.waitForExistence(timeout: 10), name + app.debugDescription)
            XCTAssertGreaterThanOrEqual(control.frame.width, 43.9, name)
            XCTAssertGreaterThanOrEqual(control.frame.height, 43.9, name)
            return control
        }
        func edge(_ name: String) {
            let control = target(name)
            control.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 2, dy: control.frame.height / 2)).tap()
        }
        for name in ["Show chats", "Search", "Open assistant details", "Pause companion", "Sample mode", "Notifications", "Conversation options", "Attach files", "Start voice input", "Start voice chat"] { _ = target(name) }
        edge("Pause companion")
        XCTAssertTrue(app.buttons["Wake companion"].waitForExistence(timeout: 5))
        composer.tap(); composer.typeText("Keep this phone draft")
        edge("Search")
        XCTAssertTrue(app.textFields["Search your workspace"].waitForExistence(timeout: 10))
        app.buttons["Close dialog"].tap()
        XCTAssertEqual(composer.value as? String, "Keep this phone draft")
        edge("Show chats")
        XCTAssertTrue(app.buttons["New side chat"].waitForExistence(timeout: 10))
        app.buttons["New side chat"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap(); composer.typeText("A separate phone thought")
        app.buttons["Back to main chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep this phone draft")
        edge("Conversation options")
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "Mark as unread").firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        edge("Conversation options")
        edge("Start voice input")
        XCTAssertTrue(app.buttons["Back to chat"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["Back to chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep this phone draft")
        _ = target("Send message")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30))
        XCTAssertEqual(composer.value as? String, "Keep this phone draft")
        // Message controls remain reachable beside the bubble with native touch input.
        app.buttons["Send message"].tap()
        let more = app.buttons.matching(identifier: "Message actions").firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertGreaterThanOrEqual(more.frame.width, 43.9)
        XCTAssertGreaterThanOrEqual(more.frame.height, 43.9)
        XCTAssertGreaterThanOrEqual(more.frame.minX, app.frame.minX)
        XCTAssertLessThanOrEqual(more.frame.maxX, app.frame.maxX)
        more.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 2, dy: more.frame.height / 2)).tap()
        XCTAssertTrue(app.buttons["Copy message"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "React 👍").firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        app.descendants(matching: .any).matching(identifier: "React 👍").firstMatch.tap()
        XCTAssertTrue(app.buttons["Remove 👍 reaction"].waitForExistence(timeout: 10))
        more.tap(); app.buttons["Reply to message"].tap()
        XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["Cancel reply"].tap()
        composer.tap(); composer.typeText("Keep this message-action draft")
        more.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "React 👍").firstMatch.waitForExistence(timeout: 10))
        composer.tap()
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "React 👍").firstMatch.exists)
        XCTAssertEqual(composer.value as? String, "Keep this message-action draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep this message-action draft")
        XCTAssertTrue(app.buttons["Remove 👍 reaction"].exists)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "phone-touch-chat"; capture.lifetime = .keepAlways; add(capture)
    }

    func testMemoryLifecycle() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run native memory acceptance.") }
        @discardableResult func request(_ path: String) -> String {
            let done = expectation(description: path); var value = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                value = String(data: data ?? Data(), encoding: .utf8) ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 30); return value
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<7 {
                // The keyboard accessory sits above XCUIKeyboard's frame. Keep
                // the gesture inside the resized WebView, not on that accessory.
                let chatLink = ["Memory saved", "Review memory update", "Memory forgotten"].contains(element.label)
                let viewportBottom = min(app.webViews.firstMatch.frame.maxY - 12, app.frame.maxY - 28)
                // Chat has its own scroller above the composer and shortcut bar.
                let bottom = chatLink ? min(viewportBottom, app.textViews["Message Relay"].frame.minY - 25) : viewportBottom
                let top = chatLink ? app.buttons["Open assistant details"].frame.maxY + 55 : CGFloat(145)
                let visibleTop = chatLink ? top : app.webViews.firstMatch.frame.minY
                // Source inspection intentionally preserves an older reading position.
                // Use the visible Latest control to reach a newer correction card.
                let latest = app.buttons["Latest messages"]
                if chatLink && element.frame.minY > bottom && latest.exists && latest.isHittable {
                    latest.tap(); continue
                }
                if element.isHittable && element.frame.minY >= visibleTop && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 32
                let start = element.frame.minY < top ? top : bottom - 24
                let end = element.frame.minY < top ? bottom - 24 : top
                app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: start)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: end)))
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func tap(_ label: String) {
            let matches = app.buttons.matching(identifier: label)
            // Older memory cards describe the same live note. Review the latest
            // reply's card, which is the one visible beside the current composer.
            let button = label == "Review memory update" ? matches.element(boundBy: max(0, matches.count - 1)) : matches.firstMatch
            reveal(button); button.tap()
        }
        func fill(_ field: XCUIElement, _ value: String, replace: Bool = false) {
            reveal(field); field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
            if replace {
                // The synthetic values fit on one line. Tap beyond the text
                // and use ordinary backspaces; Simulator's hardware Select All
                // shortcut does not consistently select WebKit field contents.
                let previous = (field.value as? String) ?? ""
                field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: previous.count))
                XCTAssertTrue((field.value as? String ?? "").isEmpty || field.value as? String == field.placeholderValue, app.debugDescription)
            }
            field.typeText(value); if field.elementType != .secureTextField { XCTAssertEqual(field.value as? String, value) }
        }
        fill(app.secureTextFields["Server access key"], request("/credential")); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        func send(_ text: String, waitingFor label: String) {
            fill(composer, text, replace: (composer.value as? String) == "Keep my trip draft"); tap("Send message")
            XCTAssertTrue(app.buttons[label].firstMatch.waitForExistence(timeout: 40), app.debugDescription)
            fill(composer, "Keep my trip draft")
        }
        func memories() { tap("Open assistant details"); tap("My memories") }
        send("I prefer quiet hotels. Help me plan.", waitingFor: "Memory saved")
        request("/learned"); tap("Memory saved")
        let quote = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Source quote")).firstMatch
        reveal(quote)
        // WebKit reports a summary's text bounds, not its padded hit area.
        // Tap below those glyphs to exercise the larger native touch target.
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: quote.frame.midX, dy: quote.frame.midY + 18)).tap()
        XCTAssertTrue(app.staticTexts["I prefer quiet hotels"].waitForExistence(timeout: 10))
        tap("From your message")
        XCTAssertTrue(composer.waitForExistence(timeout: 20)); XCTAssertEqual(composer.value as? String, "Keep my trip draft")
        memories(); tap("Edit memory Prefers quiet hotels.")
        fill(app.textViews["Edit memory"], "Quiet hotels with gardens.", replace: true); tap("Save memory")
        XCTAssertTrue(app.staticTexts["Quiet hotels with gardens."].waitForExistence(timeout: 20)); tap("Close dialog")
        send("I now prefer lively hotels. Help me plan.", waitingFor: "Review memory update")
        XCTAssertFalse(app.buttons["Close dialog"].exists)
        tap("Review memory update"); request("/proposal"); request("/capture-proposal")
        XCTAssertTrue(app.buttons["Close dialog"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Quiet hotels with gardens."].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Prefers lively hotels."].exists)
        let keep = app.buttons["Keep mine"]
        reveal(keep); XCTAssertGreaterThanOrEqual(keep.frame.height, 44)
        request("/capture-proposal"); keep.tap(); request("/kept"); tap("Close dialog")
        send("I now prefer mountain hotels. Help me plan.", waitingFor: "Review memory update")
        tap("Review memory update")
        let use = app.buttons["Use update"]
        reveal(use); XCTAssertGreaterThanOrEqual(use.frame.height, 44); use.tap()
        XCTAssertTrue(app.staticTexts["Prefers mountain hotels."].waitForExistence(timeout: 20)); request("/accepted")
        let toggle = app.switches["Learn from our chats"]
        if toggle.waitForExistence(timeout: 3) {
            reveal(toggle); XCTAssertGreaterThanOrEqual(toggle.frame.height, 44)
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: toggle.frame.midX, dy: toggle.frame.maxY - 3)).tap()
        } else { tap("Learn from our chats") }
        tap("Remove memory Prefers mountain hotels."); tap("Close dialog")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30)); XCTAssertEqual(composer.value as? String, "Keep my trip draft")
        fill(composer, "I prefer quiet hotels. Help me plan.", replace: true); tap("Send message")
        XCTAssertTrue(app.staticTexts["Learning is off. I’ll use that for this conversation without saving a new memory."].waitForExistence(timeout: 30))
        fill(composer, "Keep my trip draft"); request("/off")
        memories(); fill(app.textFields["New memory"], "Keep Fridays free."); tap("Add memory")
        XCTAssertTrue(app.staticTexts["Keep Fridays free."].waitForExistence(timeout: 20)); tap("Close dialog")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30)); XCTAssertEqual(composer.value as? String, "Keep my trip draft")
        memories(); XCTAssertTrue(app.staticTexts["Keep Fridays free."].waitForExistence(timeout: 20)); request("/manual")
        tap("Remove memory Keep Fridays free."); request("/capture-final"); tap("Close dialog")
        XCTAssertFalse(app.alerts.firstMatch.exists); request("/verify")
        fill(composer, "Please remember: I prefer quiet hotels.", replace: true); tap("Send message")
        XCTAssertTrue(app.staticTexts["Saved that preference as requested."].waitForExistence(timeout: 40), app.debugDescription)
        fill(composer, "Keep my trip draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30)); XCTAssertEqual(composer.value as? String, "Keep my trip draft")
        memories(); XCTAssertTrue(app.staticTexts["Prefers quiet hotels."].waitForExistence(timeout: 20))
        request("/explicit"); request("/capture-explicit")
        fill(app.textFields["New memory"], "Keep Fridays free."); tap("Add memory"); tap("Close dialog")
        fill(composer, "Forget my saved hotel preference.", replace: true); tap("Send message")
        XCTAssertTrue(app.staticTexts["I forgot that saved note."].waitForExistence(timeout: 40), app.debugDescription)
        XCTAssertFalse(app.buttons["Close dialog"].exists); XCTAssertFalse(app.alerts.firstMatch.exists)
        fill(composer, "Keep my trip draft"); request("/capture-chat-forgotten")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30)); XCTAssertEqual(composer.value as? String, "Keep my trip draft")
        memories(); XCTAssertTrue(app.staticTexts["Keep Fridays free."].waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["Prefers quiet hotels."].exists)
        request("/forgotten"); request("/capture-forgotten")
    }

    func testPdfFormCompletion() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run PDF form acceptance.") }
        @discardableResult func request(_ path: String) -> String {
            let done = expectation(description: path); var value = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                value = String(data: data ?? Data(), encoding: .utf8) ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 30); return value
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func tap(_ label: String) {
            let button = app.buttons[label]; XCTAssertTrue(button.waitForExistence(timeout: 30), app.debugDescription); button.tap()
        }
        func fill(_ field: XCUIElement, _ text: String) {
            XCTAssertTrue(field.waitForExistence(timeout: 30), app.debugDescription); field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(text)
        }
        func page(_ number: Int) {
            XCTAssertTrue(app.otherElements["filled-Riverbank.pdf, page \(number)"].waitForExistence(timeout: 20), app.debugDescription)
            let rendered = NSPredicate { _, _ in !app.staticTexts["Rendering document…"].exists }
            expectation(for: rendered, evaluatedWith: nil); waitForExpectations(timeout: 20)
        }
        fill(app.secureTextFields["Server access key"], request("/credential")); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        fill(composer, request("/prompt")); tap("Send message")
        XCTAssertTrue(app.staticTexts["Your filled form is ready. I kept the original and its reference."].waitForExistence(timeout: 40), app.debugDescription)
        request("/ready")
        fill(composer, "Keep my next thought")
        let result = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "filled-Riverbank.pdf")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 15), app.debugDescription); result.tap()
        XCTAssertTrue(app.buttons["All files"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.buttons["Close dialog"].exists)
        page(1); request("/capture1")
        tap("Next PDF page"); page(2); request("/capture2")
        XCTAssertFalse(app.buttons["Next PDF page"].isEnabled)
        tap("Back to chat"); tap("Files"); tap("Back to chat")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my next thought")
        XCTAssertTrue(result.waitForExistence(timeout: 15), app.debugDescription); result.tap(); page(1)
        tap("Back to chat"); request("/verify")
    }

    func testChatRetry() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run chat retry acceptance.") }
        @discardableResult func request(_ path: String) -> String {
            let done = expectation(description: path); var value = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                value = String(data: data ?? Data(), encoding: .utf8) ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 20); return value
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func tap(_ label: String) {
            let button = app.buttons[label]; XCTAssertTrue(button.waitForExistence(timeout: 30), app.debugDescription); button.tap()
        }
        func fill(_ field: XCUIElement, _ text: String) {
            XCTAssertTrue(field.waitForExistence(timeout: 30), app.debugDescription); field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(text)
        }
        fill(app.secureTextFields["Server access key"], request("/credential")); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        fill(composer, "Save a note about our Saturday plan."); tap("Send message")
        let retry = app.buttons["Try again"]
        XCTAssertTrue(retry.waitForExistence(timeout: 30), app.debugDescription)
        fill(composer, "Keep my next thought")
        tap("Files"); tap("Back to chat")
        app.terminate(); app.launch()
        XCTAssertTrue(retry.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my next thought")
        XCTAssertGreaterThanOrEqual(retry.frame.height, 44)
        request("/ready"); retry.tap()
        XCTAssertTrue(app.staticTexts["Trying again…"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertFalse(retry.exists)
        request("/release")
        XCTAssertTrue(app.staticTexts["Your Saturday note is saved. We can continue."].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my next thought")
        XCTAssertFalse(app.alerts.firstMatch.exists)
        request("/capture"); request("/verify")
    }


    func testChatReadingPosition() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run chat reading acceptance.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 20)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func tap(_ label: String) {
            let button = app.buttons[label]; XCTAssertTrue(button.waitForExistence(timeout: 25), app.debugDescription); button.tap()
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription); key.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { key.tap() }
        key.typeText("reading-native-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        func older() {
            for _ in 0..<3 {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.32))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.73)))
            }
            XCTAssertTrue(app.buttons["Latest messages"].waitForExistence(timeout: 10), app.debugDescription)
        }
        func anchor(_ prefix: String) -> (String, CGFloat) {
            let notes = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).allElementsBoundByIndex
            guard let note = notes.first(where: { $0.isHittable && $0.frame.minY > 135 && $0.frame.maxY < composer.frame.minY }) else {
                XCTFail("No visible reading anchor: " + app.debugDescription); return ("missing", 0)
            }
            return (note.label, note.frame.minY)
        }
        func verify(_ saved: (String, CGFloat)) {
            let note = app.staticTexts.matching(NSPredicate(format: "label == %@", saved.0)).firstMatch
            XCTAssertTrue(note.waitForExistence(timeout: 15), app.debugDescription)
            let settled = NSPredicate { _, _ in note.isHittable && abs(note.frame.minY - saved.1) < 6 }
            expectation(for: settled, evaluatedWith: nil); waitForExpectations(timeout: 15)
            XCTAssertTrue(app.buttons["Latest messages"].exists)
        }
        func select(_ name: String) { tap("Show chats"); tap(name) }
        XCTAssertEqual(composer.value as? String, "Keep the main draft")
        older(); let main = anchor("Main note ")
        select("Reading side chat"); XCTAssertEqual(composer.value as? String, "Keep the side draft")
        older(); let side = anchor("Side note ")
        select("Main chat"); verify(main)
        select("Reading side chat"); verify(side)
        select("Main chat"); verify(main)
        tap("Files"); request("/arrival"); tap("Back to chat"); verify(main)
        request("/capture")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep the main draft"); verify(main)
        tap("Latest messages")
        let arrived = app.staticTexts["A new result arrived while you were reading."]
        XCTAssertTrue(arrived.waitForExistence(timeout: 15)); XCTAssertTrue(arrived.isHittable)
        request("/verify")
    }

    func testComputerPageSimplicity() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run computer layout acceptance.") }
        @discardableResult func request(_ path: String) -> String {
            let done = expectation(description: path); var value = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                value = String(data: data ?? Data(), encoding: .utf8) ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 30); return value
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func tap(_ name: String) {
            let element = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); element.tap()
        }
        func fill(_ field: XCUIElement, _ text: String) {
            XCTAssertTrue(field.waitForExistence(timeout: 30), app.debugDescription); field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(text)
        }
        func openComputer() { tap("More"); tap("Computer"); tap("Desktop") }
        fill(app.secureTextFields["Server access key"], request("/credential")); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { tap("Pause companion") }
        fill(composer, "Keep my layout draft"); openComputer()
        let screen = app.buttons["Control private desktop"]
        XCTAssertTrue(screen.waitForExistence(timeout: 30), app.debugDescription)
        let type = app.textFields["Type on the computer"]
        let drag = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Drag on the computer")).firstMatch
        XCTAssertTrue(drag.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertLessThan(screen.frame.minY - app.buttons["Back to chat"].frame.maxY, 200)
        XCTAssertLessThan(type.frame.maxY, app.buttons["More"].frame.minY)
        XCTAssertLessThan(drag.frame.maxY, app.buttons["More"].frame.minY)
        request("/capture")
        let originalY = screen.frame.minY
        screen.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
            .press(forDuration: 0.05, thenDragTo: screen.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)))
        XCTAssertLessThan(screen.frame.minY, originalY - 25, app.debugDescription)
        request("/swiped")
        tap("Back to chat"); openComputer()
        XCTAssertTrue(screen.waitForExistence(timeout: 20)); tap("Drag on the computer")
        let dragStartY = screen.frame.minY
        screen.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.4))
            .press(forDuration: 0.15, thenDragTo: screen.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.6)))
        XCTAssertEqual(screen.frame.minY, dragStartY, accuracy: 2)
        request("/dragged"); tap("Drag on the computer")
        fill(type, "hello from the simpler computer"); tap("Type text"); request("/typed")
        let hiddenKeyboard = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [hiddenKeyboard], timeout: 10), .completed)
        tap("Back to chat"); XCTAssertEqual(composer.value as? String, "Keep my layout draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30)); XCTAssertEqual(composer.value as? String, "Keep my layout draft")
        request("/verify")
    }

    func testHostedRemoteComputer() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run remote computer acceptance.") }
        @discardableResult func request(_ path: String) -> String {
            let done = expectation(description: path); var value = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                value = String(data: data ?? Data(), encoding: .utf8) ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 120); return value
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 45), app.debugDescription)
            for _ in 0..<16 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 130
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                // Scroll in the page margin, outside the interactive remote screen.
                let x = app.frame.minX + 8
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY)))
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func tap(_ name: String) { let field = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch; if name == "More" || name == "Back to chat" { XCTAssertTrue(field.waitForExistence(timeout: 30)); field.tap(); return }; reveal(field); field.tap() }
        func fill(_ field: XCUIElement, _ text: String) {
            reveal(field); field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(text)
        }
        fill(app.secureTextFields["Server access key"], request("/credential")); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 40), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my remote iPhone draft."); tap("More"); tap("Computer"); tap("Desktop")
        tap("Start computer"); tap("Take control"); tap("Commands & activity")
        fill(app.textViews["Private computer command"], "printf 'Made on the remote iPhone computer' > iphone-proof.txt")
        tap("Run command"); request("/file")
        if app.keyboards.buttons["Done"].exists { app.keyboards.buttons["Done"].tap() }
        tap("Commands & activity"); tap("Back to chat")
        XCTAssertEqual(composer.value as? String, "Keep my remote iPhone draft.")
        request("/restart"); app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 45), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my remote iPhone draft.")
        tap("More"); tap("Computer"); tap("Desktop")
        XCTAssertTrue(app.buttons["Give back to Relay"].waitForExistence(timeout: 30), app.debugDescription)
        tap("Stop computer and keep files"); tap("Start computer")
        XCTAssertTrue(app.buttons["Give back to Relay"].waitForExistence(timeout: 45), app.debugDescription)
        request("/verify")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "remote-computer-native-iphone"; shot.lifetime = .keepAlways; add(shot)
        tap("Give back to Relay"); tap("Back to chat")
        XCTAssertEqual(composer.value as? String, "Keep my remote iPhone draft.")
    }

    func testHostedLinuxListening() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run Linux listening acceptance.") }
        @discardableResult func request(_ path: String) -> String {
            let done = expectation(description: path); var result = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = String(data: data ?? Data(), encoding: .utf8) ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 120); return result
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func tap(_ name: String) { let button = app.buttons[name]; XCTAssertTrue(button.waitForExistence(timeout: 40), app.debugDescription); button.tap() }
        func fill(_ field: XCUIElement, _ text: String) {
            XCTAssertTrue(field.waitForExistence(timeout: 40), app.debugDescription); field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(text)
        }
        fill(app.secureTextFields["Server access key"], request("/credential")); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 40), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my Linux iPhone draft.")
        tap("More"); tap("Settings"); tap("Voice")
        XCTAssertTrue(app.staticTexts["148"].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(app.staticTexts["MB download · No account needed"].exists, app.debugDescription)
        tap("Set up local listening")
        XCTAssertTrue(app.staticTexts["Your speech is transcribed on your Relay computer."].waitForExistence(timeout: 300), app.debugDescription)
        request("/installed"); tap("Back to chat")
        XCTAssertEqual(composer.value as? String, "Keep my Linux iPhone draft.")
        tap("Start voice input"); request("/pulse"); tap("Done recording")
        let dictated = NSPredicate(format: "value CONTAINS[cd] %@", "water the plants tomorrow morning")
        expectation(for: dictated, evaluatedWith: composer); waitForExpectations(timeout: 100)
        request("/dictated")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 40), app.debugDescription)
        XCTAssertTrue((composer.value as? String ?? "").contains("water the plants tomorrow morning"))
        tap("Send message")
        XCTAssertTrue(app.staticTexts["I have your message."].waitForExistence(timeout: 40), app.debugDescription)
        tap("Start voice chat")
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 30), app.debugDescription)
        fill(composer, "Keep my final Linux voice draft."); request("/pulse")
        XCTAssertTrue(app.staticTexts["Relay is speaking"].waitForExistence(timeout: 100), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 35), app.debugDescription)
        tap("End call"); request("/restart")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 60), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my final Linux voice draft.")
        XCTAssertFalse(app.buttons["End call"].exists)
        request("/verify")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "linux-listening-native-iphone"; shot.lifetime = .keepAlways; add(shot)
    }

    func testHostedLinuxWorkspace() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated Linux hosting acceptance.") }
        @discardableResult func request(_ path: String) -> String {
            let done = expectation(description: path)
            var value = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                value = String(data: data ?? Data(), encoding: .utf8) ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 120); return value
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func tap(_ name: String) { let button = app.buttons[name]; XCTAssertTrue(button.waitForExistence(timeout: 40), app.debugDescription); button.tap() }
        func fill(_ field: XCUIElement, _ text: String) {
            XCTAssertTrue(field.waitForExistence(timeout: 40), app.debugDescription); field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(text)
        }
        fill(app.secureTextFields["Server access key"], request("/credential")); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 40), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Hello from the native iPhone on Linux."); tap("Send message")
        request("/sent")
        fill(composer, "Keep my hosted iPhone draft."); request("/draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 40), app.debugDescription)
        XCTAssertFalse(app.secureTextFields["Server access key"].exists)
        XCTAssertEqual(composer.value as? String, "Keep my hosted iPhone draft.")
        request("/restart")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 60), app.debugDescription)
        XCTAssertFalse(app.secureTextFields["Server access key"].exists)
        XCTAssertEqual(composer.value as? String, "Keep my hosted iPhone draft.")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "hosted-linux-native-iphone"; shot.lifetime = .keepAlways; add(shot)
        request("/verify")
    }

    func testLocalVoiceQuickSetup() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated local listening fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 45)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 40), app.debugDescription)
            for _ in 0..<12 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 150
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY)))
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func tap(_ label: String) { let button = app.buttons[label]; reveal(button); button.tap() }
        func fill(_ field: XCUIElement, _ value: String, replace: Bool = false) {
            XCTAssertTrue(field.waitForExistence(timeout: 30), app.debugDescription)
            field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
            if replace { field.typeKey("a", modifierFlags: .command); field.typeText(XCUIKeyboardKey.delete.rawValue) }
            if !value.isEmpty { field.typeText(value) }
        }
        func capture(_ name: String) { let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot) }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my native listening draft.")
        tap("Start voice input")
        XCTAssertTrue(app.buttons["Set up voice"].waitForExistence(timeout: 30), app.debugDescription)
        request("/before-setup"); capture("chat-voice-entry-native-start")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native listening draft.")
        request("/before-setup")
        tap("Start voice input")
        tap("Set up voice")
        XCTAssertTrue(app.staticTexts["Voice is ready."].waitForExistence(timeout: 90), app.debugDescription)
        request("/installed"); capture("voice-quick-native-setup")
        app.buttons["Back to chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my native listening draft.")
        tap("Start voice input")
        XCTAssertTrue(app.staticTexts["Listening…"].waitForExistence(timeout: 15), app.debugDescription)
        request("/pulse"); tap("Done recording")
        let heard = NSPredicate(format: "value CONTAINS[c] %@", "water the plants tomorrow morning")
        expectation(for: heard, evaluatedWith: composer); waitForExpectations(timeout: 80)
        request("/dictated"); capture("voice-quick-native-dictation")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue((composer.value as? String ?? "").contains("water the plants tomorrow morning"))
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["Take a short walk and enjoy a quiet afternoon."].waitForExistence(timeout: 40), app.debugDescription)
        tap("Start voice chat")
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 20), app.debugDescription)
        fill(composer, "Keep my final native listening draft.")
        request("/pulse")
        XCTAssertTrue(app.staticTexts["Relay is speaking"].waitForExistence(timeout: 80), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 35), app.debugDescription)
        tap("End call"); request("/verify"); capture("voice-quick-native-call")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my final native listening draft.")
        XCTAssertFalse(app.buttons["End call"].exists)
    }


    func testLocalListeningSetupAndDictation() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated local listening fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 45)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 40), app.debugDescription)
            for _ in 0..<12 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 150
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY)))
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func tap(_ label: String) { let button = app.buttons[label]; reveal(button); button.tap() }
        func fill(_ field: XCUIElement, _ value: String, replace: Bool = false) {
            XCTAssertTrue(field.waitForExistence(timeout: 30), app.debugDescription)
            field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
            if replace { field.typeKey("a", modifierFlags: .command); field.typeText(XCUIKeyboardKey.delete.rawValue) }
            if !value.isEmpty { field.typeText(value) }
        }
        func capture(_ name: String) { let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot) }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my native listening draft.")
        app.buttons["More"].tap(); tap("Settings"); tap("Voice")
        tap("Voice options"); tap("Set up local listening")
        XCTAssertTrue(app.staticTexts["Your speech is transcribed on your Relay computer."].waitForExistence(timeout: 90), app.debugDescription)
        tap("Use Mac voice"); request("/installed"); capture("local-listening-native-setup")
        app.buttons["Back to chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my native listening draft.")
        tap("Start voice input")
        XCTAssertTrue(app.staticTexts["Listening…"].waitForExistence(timeout: 15), app.debugDescription)
        request("/pulse"); tap("Done recording")
        let heard = NSPredicate(format: "value CONTAINS[c] %@", "water the plants tomorrow morning")
        expectation(for: heard, evaluatedWith: composer); waitForExpectations(timeout: 80)
        request("/dictated"); capture("local-listening-native-dictation")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue((composer.value as? String ?? "").contains("water the plants tomorrow morning"))
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["Take a short walk and enjoy a quiet afternoon."].waitForExistence(timeout: 40), app.debugDescription)
        tap("Start voice chat")
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 20), app.debugDescription)
        fill(composer, "Keep my final native listening draft.")
        request("/pulse")
        XCTAssertTrue(app.staticTexts["Relay is speaking"].waitForExistence(timeout: 80), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 35), app.debugDescription)
        tap("End call"); request("/verify"); capture("local-listening-native-call")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my final native listening draft.")
        XCTAssertFalse(app.buttons["End call"].exists)
    }

    func testMacSystemVoiceAndSavedReply() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated Mac system-voice fixture.")
        }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<12 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 150
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY)))
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func tap(_ label: String) { let button = app.buttons[label]; reveal(button); button.tap() }
        func fill(_ field: XCUIElement, _ value: String) {
            XCTAssertTrue(field.waitForExistence(timeout: 30), app.debugDescription)
            field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my native voice draft")
        app.buttons["More"].tap(); tap("Settings"); tap("Voice")
        request("/before")
        tap("Use Mac voice"); tap("Preview Mac voice")
        XCTAssertTrue(app.staticTexts["Your Mac voice preview is ready."].waitForExistence(timeout: 80), app.debugDescription)
        request("/preview"); capture("system-voice-native-iphone-setup")
        app.buttons["Back to chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my native voice draft")
        composer.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeKey("a", modifierFlags: .command); composer.typeText("Plan a quiet afternoon.")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["Take a short walk and enjoy a quiet afternoon."].waitForExistence(timeout: 30), app.debugDescription)
        let actions = app.buttons.matching(identifier: "Message actions").element(boundBy: 1)
        reveal(actions); actions.tap(); tap("Create voice memo")
        let play = app.buttons["Play voice memo"]
        XCTAssertTrue(play.waitForExistence(timeout: 80), app.debugDescription); reveal(play); play.tap()
        XCTAssertTrue(app.buttons["Pause voice memo"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(play.waitForExistence(timeout: 20), app.debugDescription)
        request("/audio"); capture("system-voice-native-iphone-reply")
        fill(composer, "Keep my final native voice draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my final native voice draft")
        XCTAssertTrue(play.waitForExistence(timeout: 30), app.debugDescription)
        reveal(play); play.tap(); XCTAssertTrue(app.buttons["Pause voice memo"].waitForExistence(timeout: 10), app.debugDescription)
        request("/verify")
    }

    func testDeviceConnectionLink() throws {
        continueAfterFailure = false
        guard let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated device-link fixture.") }
        func request(_ path: String) -> String {
            let done = expectation(description: path); var value = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                value = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 30); return value
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", ""]; app.launch()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        func fill(_ field: XCUIElement, _ value: String, replace: Bool = false) {
            XCTAssertTrue(field.waitForExistence(timeout: 20), app.debugDescription); field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
            if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
            if replace, let current = field.value as? String, current != field.placeholderValue, !current.isEmpty {
                let clear = field.buttons["Clear text"]
                XCTAssertTrue(clear.waitForExistence(timeout: 5), app.debugDescription)
                clear.tap()
            }
            field.typeText(value)
            XCTAssertEqual(field.value as? String, value)
        }
        func capture(_ name: String) { let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot) }
        func connect() {
            app.buttons["Connect your devices"].tap()
            let dialog = app.alerts["Connect your devices"]
            XCTAssertTrue(dialog.waitForExistence(timeout: 10), app.debugDescription)
            fill(dialog.textFields["Relay server address"], request("/link"), replace: true)
            dialog.buttons["Connect"].tap()
            let accept = app.buttons["Connect this device"]
            XCTAssertTrue(accept.waitForExistence(timeout: 30), app.debugDescription)
            XCTAssertFalse(app.secureTextFields["Server access key"].exists)
            XCTAssertEqual(app.textFields["Device name"].value as? String, "My iPhone")
            capture("device-link-native-review"); accept.tap()
            XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        }
        app.buttons["More"].tap(); app.buttons["Settings"].tap(); app.buttons["Data & devices"].tap(); connect()
        fill(composer, "Hello from my linked iPhone")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["Your devices are sharing this conversation."].waitForExistence(timeout: 30), app.debugDescription)
        fill(composer, "Keep my native connected thought")
        _ = request("/saved"); capture("device-link-native-conversation")
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native connected thought")
        _ = request("/revoke")
        XCTAssertTrue(app.secureTextFields["Server access key"].waitForExistence(timeout: 30), app.debugDescription)
        connect()
        XCTAssertEqual(composer.value as? String, "Keep my native connected thought")
        _ = request("/verify"); capture("device-link-native-restored")
    }

    func testChatOrganization() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", ""]; app.launch()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        func fill(_ text: String) {
            composer.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
            if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
            composer.typeText(text)
            expectation(for: NSPredicate(format: "value == %@", text), evaluatedWith: composer); waitForExpectations(timeout: 10)
        }
        func action(_ title: String) -> XCUIElement {
            return app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", title)).firstMatch
        }
        fill("Keep my main organization draft")
        app.buttons["Show chats"].tap(); app.buttons["New side chat"].tap()
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Conversation options")).firstMatch.tap(); action("Rename conversation").tap()
        let title = app.textFields["Conversation title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10)); title.tap(); title.typeText(" Organized native chat")
        expectation(for: NSPredicate(format: "value CONTAINS %@", "Organized native chat"), evaluatedWith: title); waitForExpectations(timeout: 10)
        let savedTitle = (title.value as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        app.buttons["Save title"].tap(); fill("Keep my side organization draft")
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Conversation options")).firstMatch.tap(); action("Pin conversation").tap()
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Conversation options")).firstMatch.tap(); action("Mark as unread").tap()
        app.buttons["Back to main chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my main organization draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my main organization draft")
        app.buttons["Show chats"].tap()
        let options = action("Options for " + savedTitle)
        XCTAssertTrue(options.waitForExistence(timeout: 10), app.debugDescription); options.tap()
        XCTAssertTrue(action("Unpin conversation").waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(action("Mark as read").exists)
        let list = XCTAttachment(screenshot: app.screenshot()); list.name = "chat-list-native-menu"; list.lifetime = .keepAlways; add(list)
        action("Mark as read").tap()
        app.buttons[savedTitle].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my side organization draft")
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Conversation options")).firstMatch.tap()
        XCTAssertTrue(action("Mark as unread").waitForExistence(timeout: 10), app.debugDescription)
        action("Unpin conversation").tap()
        let chat = XCTAttachment(screenshot: app.screenshot()); chat.name = "chat-list-native-draft"; chat.lifetime = .keepAlways; add(chat)
    }

    func testDeviceLanguage() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", ""]
        app.launch()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        composer.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        composer.typeText("Keep my language draft")
        expectation(for: NSPredicate(format: "value == %@", "Keep my language draft"), evaluatedWith: composer)
        waitForExpectations(timeout: 10)
        app.buttons["More"].tap(); app.buttons["Settings"].tap(); app.buttons["Appearance & personality"].tap()
        let language = app.otherElements.matching(NSPredicate(format: "label == %@ AND value == %@", "App language", "Follow system")).firstMatch
        XCTAssertTrue(language.waitForExistence(timeout: 10), app.debugDescription)
        for _ in 0..<8 {
            if language.isHittable && language.frame.maxY < app.frame.maxY - 100 { break }
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.75))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.3))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        language.tap()
        let chinese = app.buttons["简体中文"]
        if chinese.waitForExistence(timeout: 3) { chinese.tap() }
        else {
            let choice = app.pickerWheels.firstMatch
            XCTAssertTrue(choice.waitForExistence(timeout: 5), app.debugDescription)
            choice.adjust(toPickerWheelValue: "简体中文")
            if app.buttons["Done"].exists { app.buttons["Done"].tap() }
        }
        XCTAssertTrue(app.otherElements.matching(NSPredicate(format: "label == %@ AND value == %@", "界面语言", "简体中文")).firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        let settings = XCTAttachment(screenshot: app.screenshot()); settings.name = "language-native-settings"; settings.lifetime = .keepAlways; add(settings)
        app.buttons["返回聊天"].tap()
        let localized = app.textViews["给Relay发消息"]
        XCTAssertTrue(localized.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(localized.value as? String, "Keep my language draft")
        XCTAssertTrue(app.buttons["更多"].exists)
        app.terminate(); app.launch()
        XCTAssertTrue(localized.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(localized.value as? String, "Keep my language draft")
        XCTAssertTrue(app.buttons["更多"].exists)
        let chat = XCTAttachment(screenshot: app.screenshot()); chat.name = "language-native-relaunch"; chat.lifetime = .keepAlways; add(chat)
    }

    func testDirectPageRequests() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", ""]
        app.launch()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        func fill(_ value: String) {
            composer.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
            if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
            composer.typeText(value)
            expectation(for: NSPredicate(format: "value == %@", value), evaluatedWith: composer)
            waitForExpectations(timeout: 10)
        }
        fill("Keep my main thought")
        app.buttons["Show chats"].tap(); app.buttons["New side chat"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Conversation options")).firstMatch.tap(); app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Rename conversation")).firstMatch.tap()
        let title = app.textFields["Conversation title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10), app.debugDescription)
        title.tap(); title.typeText(" Native quick pages")
        expectation(for: NSPredicate(format: "value CONTAINS %@", "Native quick pages"), evaluatedWith: title)
        waitForExpectations(timeout: 10)
        app.buttons["Save title"].tap()
        fill("show my files")
        XCTAssertTrue(app.buttons["Open Files"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["Ask Relay instead"].exists)
        let preview = XCTAttachment(screenshot: app.screenshot()); preview.name = "direct-navigation-native-preview"; preview.lifetime = .keepAlways; add(preview)
        app.buttons["Go to Files"].tap()
        XCTAssertTrue(app.buttons["Back to chat"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(composer.exists)
        app.buttons["Back to chat"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Message Relay…")
        XCTAssertFalse(app.staticTexts["show my files"].exists)
        XCTAssertTrue(app.buttons["Back to main chat"].exists)
        fill("open appearance settings")
        app.buttons["Go to Appearance & personality"].tap()
        XCTAssertTrue(app.textFields["Your name"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["Back to chat"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        fill("show my files from yesterday")
        XCTAssertFalse(app.buttons["Go to Files"].exists)
        XCTAssertTrue(app.buttons["Send message"].exists)
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        // A full native launch starts in Main chat; the side draft is saved with its chat.
        XCTAssertEqual(composer.value as? String, "Keep my main thought")
        app.buttons["Show chats"].tap()
        let savedChat = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Native quick pages")).firstMatch
        XCTAssertTrue(savedChat.waitForExistence(timeout: 10), app.debugDescription)
        savedChat.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "show my files from yesterday")
        XCTAssertFalse(app.buttons["Go to Files"].exists)
        app.buttons["Back to main chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my main thought")
        let draft = XCTAttachment(screenshot: app.screenshot()); draft.name = "direct-navigation-native-draft"; draft.lifetime = .keepAlways; add(draft)
    }

    func testComputerRestorePoints() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated native restore-point fixture.")
        }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 45)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<14 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY - 10 : app.frame.maxY - 92
                let back = app.buttons["Back to chat"]
                let top = element.label != "Back to chat" && back.exists ? max(110, back.frame.maxY + 12) : 110
                if element.isHittable && element.frame.minY > top && element.frame.maxY < bottom { return }
                let down = element.frame.minY < top
                let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: down ? 0.35 : 0.72))
                let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: down ? 0.75 : 0.32))
                start.press(forDuration: 0.05, thenDragTo: end)
            }
            XCTFail("Could not reveal \(element.label) outside the sticky header and keyboard. \(app.debugDescription)")
        }
        func tap(_ label: String) {
            let element = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
            reveal(element); element.tap()
        }
        func tapPoint(_ prefix: String) {
            let element = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
            reveal(element); element.tap()
        }
        func fill(_ field: XCUIElement, _ value: String) {
            reveal(field); field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
            field.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        func openComputer() { app.buttons["More"].tap(); tap("Computer") }
        func command(_ value: String) {
            tap("Commands & activity"); fill(app.textViews["Private computer command"], value); tap("Run command")
            let run = app.buttons["Run command"]
            let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in run.isEnabled }, object: run)
            XCTAssertEqual(XCTWaiter.wait(for: [completed], timeout: 30), .completed, app.debugDescription)
            if app.keyboards.buttons["Done"].exists { app.keyboards.buttons["Done"].tap() }
        }
        let composer = app.textViews["Message Relay"], draft = "Keep my iPhone restore draft"
        let restored = app.staticTexts["Your workspace is restored. Check your work, then give control back to Relay."]
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap(); XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["More"].tap(); tap("Settings"); tap("Data & devices"); app.buttons["Connect your devices"].tap()
        let connection = app.alerts["Connect your devices"]
        XCTAssertTrue(connection.waitForExistence(timeout: 10), app.debugDescription); connection.buttons["Connect"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, draft); openComputer(); tap("Start computer")
        XCTAssertTrue(app.buttons["Take control"].waitForExistence(timeout: 45), app.debugDescription); tap("Take control")
        command("printf 'iPhone before' > native-restore.txt")
        tap("Restore points"); tap("Save restore point")
        XCTAssertTrue(app.staticTexts["Restore point saved. Your computer is ready to use."].waitForExistence(timeout: 120), app.debugDescription)
        request("/saved"); capture("computer-snapshots-native-saved")
        tap("Back to chat"); XCTAssertEqual(composer.value as? String, draft); openComputer()
        command("printf 'iPhone later' > native-restore.txt; printf 'later file' > later.txt")
        tap("Restore points"); tapPoint("Review restore point Saved restore point,")
        XCTAssertTrue(app.buttons["Restore workspace"].waitForExistence(timeout: 15), app.debugDescription)
        capture("computer-snapshots-native-review"); request("/reviewed")
        tap("Not now"); request("/dismissed"); tapPoint("Review restore point Saved restore point,")
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription); XCTAssertEqual(composer.value as? String, draft)
        openComputer(); tap("Restore points"); request("/review-reopened"); tap("Restore workspace")
        XCTAssertTrue(restored.waitForExistence(timeout: 120), app.debugDescription)
        request("/restored"); capture("computer-snapshots-native-restored")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription); XCTAssertEqual(composer.value as? String, draft)
        openComputer(); tap("Restore points"); request("/reopened")
        tapPoint("Review restore point Before restore,"); tap("Restore workspace")
        XCTAssertTrue(restored.waitForExistence(timeout: 120), app.debugDescription)
        request("/undo"); capture("computer-snapshots-native-undone")
        tapPoint("Review removal of restore point Saved restore point,"); tap("Not now"); request("/removal-dismissed")
        tapPoint("Review removal of restore point Saved restore point,"); tap("Remove restore point")
        XCTAssertTrue(app.staticTexts["Restore point removed."].waitForExistence(timeout: 30), app.debugDescription); request("/removed")
        tap("Give back to Relay"); XCTAssertTrue(app.buttons["Take control"].waitForExistence(timeout: 30), app.debugDescription)
        tap("Back to chat"); XCTAssertTrue(composer.waitForExistence(timeout: 20), app.debugDescription); XCTAssertEqual(composer.value as? String, draft)
        request("/verify"); capture("computer-snapshots-native-chat-preserved")
    }

    func testComputerSetupUpdateAndRecovery() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated native computer-lifecycle fixture.")
        }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 45)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement, down: Bool = false) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<12 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY - 10 : app.frame.maxY - 92
                let back = app.buttons["Back to chat"]
                let top = element.label != "Back to chat" && back.exists ? max(110, back.frame.maxY + 12) : 110
                if element.isHittable && element.frame.minY > top && element.frame.maxY < bottom { return }
                let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: down ? 0.35 : 0.72))
                let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: down ? 0.75 : 0.32))
                start.press(forDuration: 0.05, thenDragTo: end)
            }
        }
        func tap(_ label: String, down: Bool = false) {
            let element = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
            reveal(element, down: down); element.tap()
        }
        func fill(_ field: XCUIElement, _ value: String) {
            reveal(field); field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
            field.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        func openComputer() {
            app.buttons["More"].tap(); tap("Computer")
        }
        let composer = app.textViews["Message Relay"]
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        // Persist the real native server choice so later relaunches use no test launch argument.
        app.buttons["More"].tap(); tap("Settings"); tap("Data & devices")
        app.buttons["Connect your devices"].tap()
        let connection = app.alerts["Connect your devices"]
        XCTAssertTrue(connection.waitForExistence(timeout: 10), app.debugDescription); connection.buttons["Connect"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my iPhone computer lifecycle draft")
        openComputer()
        capture("computer-lifecycle-native-setup")
        tap("Set up computer")
        XCTAssertTrue(app.buttons["Cancel setup"].waitForExistence(timeout: 20), app.debugDescription)
        tap("Back to chat", down: true)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone computer lifecycle draft")
        openComputer(); tap("Cancel setup")
        XCTAssertTrue(app.staticTexts["Setup cancelled. You can continue whenever you’re ready."].waitForExistence(timeout: 20), app.debugDescription)
        request("/cancelled")
        tap("Set up computer")
        XCTAssertTrue(app.buttons["Start computer"].waitForExistence(timeout: 120), app.debugDescription)
        tap("Start computer")
        XCTAssertTrue(app.buttons["Take control"].waitForExistence(timeout: 45), app.debugDescription)
        tap("Take control"); tap("Commands & activity")
        fill(app.textViews["Private computer command"], "printf 'Native lifecycle kept me' > native-lifecycle.txt")
        tap("Run command")
        let run = app.buttons["Run command"]
        let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in run.isEnabled }, object: run)
        XCTAssertEqual(XCTWaiter.wait(for: [completed], timeout: 30), .completed, app.debugDescription)
        if app.keyboards.buttons["Done"].exists { app.keyboards.buttons["Done"].tap() }
        request("/saved")
        tap("Back to chat", down: true); openComputer()
        tap("Give back to Relay"); tap("Computer care")
        tap("Check for updates")
        XCTAssertTrue(app.buttons["Restart & update"].waitForExistence(timeout: 120), app.debugDescription)
        XCTAssertTrue(app.buttons["Restart & update"].isHittable, app.debugDescription)
        capture("computer-lifecycle-native-update-review"); request("/reviewed")
        tap("Not now"); request("/dismissed")
        tap("Check for updates")
        XCTAssertTrue(app.buttons["Restart & update"].waitForExistence(timeout: 120), app.debugDescription)
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone computer lifecycle draft")
        openComputer(); tap("Computer care"); tap("Restart & update")
        let ready = app.staticTexts["Your computer is ready. Check your work, then give control back to Relay."]
        XCTAssertTrue(ready.waitForExistence(timeout: 60), app.debugDescription)
        capture("computer-lifecycle-native-updated"); request("/updated")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone computer lifecycle draft")
        openComputer()
        XCTAssertTrue(app.buttons["Give back to Relay"].waitForExistence(timeout: 30), app.debugDescription)
        request("/reopened"); request("/break-display")
        XCTAssertTrue(app.buttons["Review recovery"].waitForExistence(timeout: 60), app.debugDescription)
        tap("Review recovery")
        XCTAssertTrue(app.buttons["Recover computer"].waitForExistence(timeout: 20), app.debugDescription)
        capture("computer-lifecycle-native-recovery-review")
        tap("Recover computer")
        XCTAssertTrue(ready.waitForExistence(timeout: 60), app.debugDescription)
        request("/recovered"); capture("computer-lifecycle-native-recovered")
        tap("Give back to Relay", down: true)
        XCTAssertTrue(app.buttons["Take control"].waitForExistence(timeout: 30), app.debugDescription)
        tap("Back to chat", down: true)
        XCTAssertTrue(composer.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone computer lifecycle draft")
        capture("computer-lifecycle-native-chat-preserved"); request("/verify")
    }

    func testNativeResultFiles() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated native results fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            for _ in 0..<8 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 50
                let back = app.buttons["Back to chat"]
                let pinned = ["Back to chat", "All files", "Back", "Stop", "Restart"].contains(element.label)
                let top = !pinned && back.exists ? back.frame.maxY + 8 : 0
                if element.isHittable && element.frame.minY >= top && element.frame.maxY < bottom - 8 { return }
                let lower = min(app.frame.height * 0.70, bottom - 25) / app.frame.height
                let above = element.exists && element.frame.minY < max(195, top)
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: above ? 0.25 : lower)).press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: above ? lower : 0.25)))
            }
        }
        func tap(_ label: String) {
            let button = app.buttons[label]; XCTAssertTrue(button.waitForExistence(timeout: 25), app.debugDescription); reveal(button); button.tap()
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        func fill(_ field: XCUIElement, _ value: String) {
            XCTAssertTrue(field.waitForExistence(timeout: 25), app.debugDescription); field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(value)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my native result draft.")
        let files = [("document", "Relay Native Document.docx"), ("spreadsheet", "Relay Native Sheet.xlsx"), ("presentation", "Relay Native Slides.pptx"), ("web", "Relay Native Page.html")]
        func open(_ name: String) {
            let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
            XCTAssertTrue(card.waitForExistence(timeout: 25), app.debugDescription); reveal(card); card.tap()
            XCTAssertTrue(app.buttons["Save file"].waitForExistence(timeout: 25), app.debugDescription)
        }
        for (kind, name) in files {
            open(name)
            if kind == "document" {
                tap("Save file")
                let cancel = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Cancel")).firstMatch
                XCTAssertTrue(cancel.waitForExistence(timeout: 25), app.debugDescription); capture("native-results-cancel-picker"); request("/picker")
                // This iOS 26 remote picker labels its ellipsis as Cancel in
                // the host AX tree. Use the visible sheet's dismissal gesture.
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.095)).press(forDuration: 0.1,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.90)))
                XCTAssertTrue(app.buttons["Save file"].waitForExistence(timeout: 20), app.debugDescription)
                XCTAssertFalse(app.staticTexts["File saved."].exists); request("/cancelled")
                XCTAssertTrue(app.buttons["All files"].exists)
                XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Result version")).firstMatch.exists)
                capture("native-results-simple-header")
                tap("Edit result")
                XCTAssertFalse(app.buttons["Save file"].exists)
                fill(app.textViews["Document text (Markdown)"], "\nUnfinished native draft.")
                tap("Preview")
                XCTAssertFalse(app.buttons["Save file"].exists)
                XCTAssertTrue(app.buttons["Edit result"].waitForExistence(timeout: 20), app.debugDescription)
                capture("native-results-unsaved-preview")
                tap("Discard edits")
                XCTAssertTrue(app.buttons["Save file"].waitForExistence(timeout: 20), app.debugDescription)
            }
            tap("Save file")
            let cancel = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Cancel")).firstMatch
            XCTAssertTrue(cancel.waitForExistence(timeout: 25), app.debugDescription); capture("native-results-picker-" + kind)
            // The captured native On My iPhone sheet places its Save action
            // here; that remote action is absent from the host AX tree.
            if app.buttons["Save"].exists { app.buttons["Save"].tap() }
            else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.875, dy: 0.126)).tap() }
            XCTAssertTrue(app.staticTexts["File saved."].waitForExistence(timeout: 25), app.debugDescription)
            request("/saved/" + kind); capture("native-results-saved-" + kind)
            if kind == "web" {
                tap("Open interactive preview")
                tap("Take a breath")
                XCTAssertTrue(app.staticTexts["1 quiet moments"].waitForExistence(timeout: 15), app.debugDescription)
                capture("native-results-interactive")
                tap("Stop")
                XCTAssertTrue(app.staticTexts["Preview stopped. Tap Restart to open it again."].waitForExistence(timeout: 15), app.debugDescription)
                tap("Restart")
                XCTAssertTrue(app.staticTexts["0 quiet moments"].waitForExistence(timeout: 15), app.debugDescription)
                tap("Back")
                XCTAssertTrue(app.buttons["Save file"].waitForExistence(timeout: 20), app.debugDescription)
            }
            tap("Back to chat")
            XCTAssertEqual(composer.value as? String, "Keep my native result draft.")
        }
        open("Relay Native Document.docx"); tap("Save file")
        let cancel = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Cancel")).firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 25), app.debugDescription); request("/interrupted")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native result draft."); request("/reopened")
        capture("native-results-reopened"); request("/verify")
    }

    func testChatComputerResume() throws {
        try chatComputerResume(asleep: false)
    }

    func testChatWhileComputerAsleep() throws {
        try chatComputerResume(asleep: true)
    }

    private func chatComputerResume(asleep: Bool) throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated chat resume fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 40)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func tap(_ label: String) {
            let button = app.buttons[label]; XCTAssertTrue(button.waitForExistence(timeout: 30), app.debugDescription); button.tap()
        }
        func fill(_ field: XCUIElement, _ text: String) {
            XCTAssertTrue(field.waitForExistence(timeout: 30), app.debugDescription); field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(text)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        XCTAssertTrue(app.buttons["Continue chatting"].waitForExistence(timeout: 30), app.debugDescription)
        if !asleep { tap("Start & resume") }
        fill(composer, "Hello after I resume"); tap(asleep ? "Send message and continue chatting" : "Send message")
        fill(composer, "Keep my iPhone resume draft")
        XCTAssertTrue(app.buttons["Cancel resume"].waitForExistence(timeout: 30), app.debugDescription); request("/waiting")
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Cancel resume"].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone resume draft"); request("/waiting")
        tap("Cancel resume")
        XCTAssertTrue(app.staticTexts["Resume cancelled. You are still in control."].waitForExistence(timeout: 30), app.debugDescription); request("/cancelled")
        tap(asleep ? "Continue chatting" : "Start & resume")
        XCTAssertTrue(app.staticTexts["Ready. We can continue."].waitForExistence(timeout: 210), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone resume draft")
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts["Ready. We can continue."].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone resume draft"); request("/verify")
    }

    func testComputerRuntimeWake() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated native computer-engine fixture.")
        }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 45)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement, down: Bool = false) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<12 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY - 10 : app.frame.maxY - 92
                let back = app.buttons["Back to chat"]
                let top = element.label != "Back to chat" && back.exists ? max(110, back.frame.maxY + 12) : 110
                if element.isHittable && element.frame.minY > top && element.frame.maxY < bottom { return }
                let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: down ? 0.35 : 0.72))
                let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: down ? 0.75 : 0.32))
                start.press(forDuration: 0.05, thenDragTo: end)
            }
        }
        func tap(_ label: String, down: Bool = false) {
            let element = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
            reveal(element, down: down); element.tap()
        }
        func fill(_ field: XCUIElement, _ value: String) {
            reveal(field); field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
            field.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        func openComputer() {
            app.buttons["More"].tap(); tap("Computer")
        }
        let composer = app.textViews["Message Relay"]
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        // Persist the real native server choice so later relaunches use no test launch argument.
        app.buttons["More"].tap(); tap("Settings"); tap("Data & devices")
        app.buttons["Connect your devices"].tap()
        let connection = app.alerts["Connect your devices"]
        XCTAssertTrue(connection.waitForExistence(timeout: 10), app.debugDescription); connection.buttons["Connect"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my iPhone runtime draft")
        openComputer()
        XCTAssertTrue(app.buttons["Start computer"].waitForExistence(timeout: 30), app.debugDescription)
        capture("computer-engine-native-asleep")
        tap("Start computer")
        let input = app.textFields["Type on the computer"]
        XCTAssertTrue(input.waitForExistence(timeout: 210), app.debugDescription)
        XCTAssertTrue(app.buttons["Give back to Relay"].exists, app.debugDescription)
        tap("Commands & activity")
        let command = app.textViews["Private computer command"]
        fill(command, "printf 'My iPhone woke this computer' > native-runtime.txt")
        XCTAssertEqual(command.value as? String, "printf 'My iPhone woke this computer' > native-runtime.txt")
        tap("Run command")
        let run = app.buttons["Run command"]
        let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in run.isEnabled }, object: run)
        XCTAssertEqual(XCTWaiter.wait(for: [completed], timeout: 30), .completed, app.debugDescription)
        if app.keyboards.buttons["Done"].exists { app.keyboards.buttons["Done"].tap() }
        request("/saved"); capture("computer-engine-native-ready")
        tap("Back to chat", down: true)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone runtime draft")
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone runtime draft")
        openComputer()
        XCTAssertTrue(input.waitForExistence(timeout: 45), app.debugDescription)
        XCTAssertTrue(app.buttons["Give back to Relay"].exists, app.debugDescription)
        request("/verify"); capture("computer-engine-native-reopened")
        tap("Back to chat", down: true)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone runtime draft")
    }

    func testUsageKeepsConversationAndDraft() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated native usage fixture.")
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription)
        func type(_ field: XCUIElement, _ value: String) {
            field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
            field.typeText(value)
        }
        type(key, "native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        type(composer, "List my files")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["Your file list is ready."].waitForExistence(timeout: 30), app.debugDescription)
        type(composer, "Keep my usage draft")
        func openUsage() {
            app.buttons["Search"].tap()
            let query = app.textFields["Search your workspace"]
            XCTAssertTrue(query.waitForExistence(timeout: 10), app.debugDescription)
            type(query, "usage")
            let result = app.buttons["Usage Settings"]
            XCTAssertTrue(result.waitForExistence(timeout: 10), app.debugDescription); result.tap()
            XCTAssertTrue(app.staticTexts["240"].waitForExistence(timeout: 15), app.debugDescription)
            XCTAssertTrue(app.staticTexts["completed"].exists, app.debugDescription)
        }
        openUsage()
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "usage-native-iphone"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.buttons["Main chat"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my usage draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my usage draft")
        openUsage(); app.buttons["Main chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my usage draft")
        let done = expectation(description: "Server usage and history")
        URLSession.shared.dataTask(with: URL(string: control + "/verify")!) { _, response, error in
            XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
        }.resume(); wait(for: [done], timeout: 20)
    }

    func testHTTPSLoginExpiredSessionAndConnectionRecovery() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run ConnectionAcceptance against its isolated HTTPS fixture.")
        }
        func trigger(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume()
            wait(for: [done], timeout: 20)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]
        app.launch()
        let key = app.secureTextFields["Server access key"]
        let composer = app.textViews["Message Relay"]
        func signIn() {
            XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription)
            key.tap(); key.typeText("native-fixture-owner-key-24-characters")
            app.buttons["Open workspace"].tap()
            XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        }
        signIn()
        app.buttons["More"].tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["Settings"].tap()
        let dataSettings = app.buttons["Data & devices"]
        for _ in 0..<6 {
            if dataSettings.isHittable && dataSettings.frame.maxY < app.frame.maxY - 100 { break }
            app.swipeUp()
        }
        dataSettings.tap()
        app.buttons["Connect your devices"].tap()
        let dialog = app.alerts["Connect your devices"]
        XCTAssertTrue(dialog.waitForExistence(timeout: 10), app.debugDescription)
        dialog.buttons["Connect"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["Show chats"].tap()
        let side = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Our weekend")).firstMatch
        XCTAssertTrue(side.waitForExistence(timeout: 10), app.debugDescription); side.tap()
        composer.tap(); composer.typeText("Keep this native draft")
        trigger("/offline")
        composer.typeText(" while disconnected")
        XCTAssertTrue(app.buttons["Reconnect"].waitForExistence(timeout: 20), app.debugDescription)
        let offline = XCTAttachment(screenshot: app.screenshot()); offline.name = "native-https-offline"; offline.lifetime = .keepAlways; add(offline)
        trigger("/online")
        let recovered = NSPredicate(format: "exists == false")
        expectation(for: recovered, evaluatedWith: app.buttons["Reconnect"])
        waitForExpectations(timeout: 20)
        XCTAssertEqual(composer.value as? String, "Keep this native draft while disconnected")
        trigger("/wait-draft")
        trigger("/expire")
        XCTAssertTrue(key.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Sign in to continue. Your unfinished message is kept on this device."].exists)
        signIn()
        XCTAssertTrue(app.staticTexts["Our weekend"].firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep this native draft while disconnected")
        trigger("/other-device")
        XCTAssertTrue(app.staticTexts["A note from the desktop"].firstMatch.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep this native draft while disconnected")
        let restored = XCTAttachment(screenshot: app.screenshot()); restored.name = "native-https-restored"; restored.lifetime = .keepAlways; add(restored)
        app.terminate()
        app.launchArguments = []
        app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertFalse(key.exists)
        app.buttons["Show chats"].tap(); side.tap()
        XCTAssertEqual(composer.value as? String, "Keep this native draft while disconnected")
        trigger("/verify")
    }


    func testPickedAppTemplate() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated app document fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            if ["More", "Back to chat", "Pause companion", "Open workspace"].contains(element.label) { return }
            for _ in 0..<12 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 100
                if element.isHittable && element.frame.minY > 145 && element.frame.maxY < bottom - 8 { return }
                let midpoint = (145 + bottom) / 2
                let distance = midpoint - element.frame.midY
                let shift = (distance < 0 ? -1.0 : 1.0) * max(20, min(110, abs(distance) * 0.4))
                let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: app.frame.width * 0.95, dy: midpoint - shift / 2))
                start.press(forDuration: 0.03, thenDragTo: start.withOffset(CGVector(dx: 0, dy: shift)))
            }
        }
        func tap(_ label: String) {
            let element = app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
        }
        func document(_ name: String) {
            let element = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
        }
        func fill(_ element: XCUIElement, _ text: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }; element.typeText(text)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription); tap("Pause companion")
        fill(composer, "Keep my native template draft")
        func openTemplate() {
            tap("More"); tap("Connect apps"); tap("Templates in Little library")
            document("A calmer plan")
        }
        openTemplate(); fill(app.textViews["mood"], "cu"); tap("Find options for mood"); tap("curious")
        XCTAssertEqual(app.textViews["mood"].value as? String, "curious")
        capture("picked-template-native-fields"); tap("Back to chat")
        XCTAssertEqual(composer.value as? String, "Keep my native template draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        openTemplate(); XCTAssertEqual(app.textViews["mood"].value as? String, "curious"); request("/browse")
        tap("Use in chat")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Here is a gentle plan:")).firstMatch.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native template draft")
        capture("picked-template-native-chat")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native template draft"); request("/verify")
    }

    func testAppDocumentBrowser() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated app document fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            if ["More", "Back to chat", "Pause companion", "Open workspace"].contains(element.label) { return }
            for _ in 0..<12 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 100
                if element.isHittable && element.frame.minY > 145 && element.frame.maxY < bottom - 8 { return }
                let midpoint = (145 + bottom) / 2
                let distance = midpoint - element.frame.midY
                let shift = (distance < 0 ? -1.0 : 1.0) * max(20, min(110, abs(distance) * 0.4))
                let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: app.frame.width * 0.95, dy: midpoint - shift / 2))
                start.press(forDuration: 0.03, thenDragTo: start.withOffset(CGVector(dx: 0, dy: shift)))
            }
        }
        func tap(_ label: String) {
            let element = app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
        }
        func document(_ name: String) {
            let element = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
        }
        func fill(_ element: XCUIElement, _ text: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }; element.typeText(text)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription); tap("Pause companion")
        fill(composer, "Keep my native document draft")
        tap("More"); tap("Connect apps"); tap("Documents in Little library")
        XCTAssertTrue(app.searchFields["Find a document"].waitForExistence(timeout: 30), app.debugDescription)
        capture("documents-native-list"); request("/browse")
        document("Weekend plan")
        XCTAssertTrue(app.staticTexts["Meet at noon. Bring a book."].waitForExistence(timeout: 30), app.debugDescription)
        capture("documents-native-preview"); tap("Ask about this")
        XCTAssertEqual(composer.value as? String, "Keep my native document draft")
        tap("More"); tap("Connect apps"); tap("Documents in Little library"); document("Daily note")
        fill(app.textFields["day"], "2026-10"); fill(app.textFields["tag"], "reading")
        request("/before-document-options"); tap("Find options for day")
        XCTAssertTrue(app.buttons["2026-10-14"].waitForExistence(timeout: 30), app.debugDescription)
        capture("document-options-native"); tap("2026-10-14")
        XCTAssertEqual(app.textFields["day"].value as? String, "2026-10-14")
        request("/document-options"); tap("Open document")
        XCTAssertTrue(app.staticTexts["Daily note: Meet at noon. Bring a book."].waitForExistence(timeout: 30), app.debugDescription)
        tap("All documents"); document("Budget file")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Train,25")).firstMatch.waitForExistence(timeout: 30), app.debugDescription)
        capture("documents-native-budget"); tap("Back to chat")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native document draft")
        XCTAssertTrue(app.buttons["Open Weekend plan.txt"].exists, app.debugDescription)
        capture("documents-native-draft"); request("/verify")
    }

    func testConnectedAppContent() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated app content fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            let pinned = ["Message Relay", "Main chat", "Files", "Ideas", "Tasks", "More", "Back to chat", "Pause companion", "Open workspace", "Send message"].contains(element.label)
            if pinned { return }
            for _ in 0..<14 {
                let chatInput = app.textViews["Message Relay"]
                let header = app.staticTexts["Main chat"].firstMatch
                let top = header.exists ? header.frame.maxY + 16 : 210
                let latest = app.buttons["Latest messages"]
                let inset = latest.exists ? 54.0 : 16.0
                let bottom = chatInput.exists ? chatInput.frame.minY - inset : app.frame.maxY - 150
                if element.isHittable && element.frame.minY >= top && element.frame.maxY < bottom { return }
                // Short proportional swipes leave room for WebKit inertia in
                // the small viewport above the keyboard and pinned composer.
                let midpoint = (top + bottom) / 2
                let distance = midpoint - element.frame.midY
                let shift = (distance < 0 ? -1.0 : 1.0) * max(20, min(100, abs(distance) * 0.3))
                let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: app.frame.width * 0.95, dy: midpoint - shift / 2))
                if app.keyboards.firstMatch.exists {
                    start.press(forDuration: 0.01, thenDragTo: start.withOffset(CGVector(dx: 0, dy: shift)), withVelocity: XCUIGestureVelocity(rawValue: 80), thenHoldForDuration: 0.1)
                } else {
                    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: shift)))
                }
            }
            XCTFail("Could not reveal \(element.label) above the composer: \(element.frame)")
        }
        func tap(_ label: String) {
            let element = app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription); key.tap(); key.typeText("native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription); tap("Pause companion")
        composer.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeText("Read my saved plan and budget, then use the calmer template.")
        tap("Send message")
        let approve = app.buttons["Use template"]
        XCTAssertTrue(approve.waitForExistence(timeout: 40), app.debugDescription); request("/reviewed")
        let mood = app.textViews["mood"]
        XCTAssertTrue(mood.waitForExistence(timeout: 20), app.debugDescription)
        reveal(mood); mood.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { mood.tap() }
        // Move to the end of this original one-line fixture through the
        // keyboard; a second spatial tap can hit the resized composer.
        mood.typeKey(XCUIKeyboardKey.rightArrow.rawValue, modifierFlags: .command)
        mood.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
        XCTAssertEqual(mood.value as? String, "")
        mood.typeText("cu")
        XCTAssertEqual(mood.value as? String, "cu")
        let findOptions = app.buttons["Find options for mood"]
        reveal(findOptions); capture("app-content-native-before-options")
        request("/before-options")
        findOptions.tap()
        let option = app.buttons["curious"]
        XCTAssertTrue(option.waitForExistence(timeout: 20), app.debugDescription)
        reveal(option); capture("app-content-native-options"); request("/options"); option.tap()
        XCTAssertEqual(mood.value as? String, "curious")
        reveal(composer); composer.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeText("Keep this next thought.")
        tap("Files"); tap("Back to chat")
        XCTAssertEqual(composer.value as? String, "Keep this next thought.")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep this next thought.")
        XCTAssertTrue(approve.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(mood.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(mood.value as? String, "curious")
        reveal(approve); capture("app-content-native-choice"); tap("Use template")
        let answer = app.staticTexts["Meet at noon, bring a book, and leave time for a quiet riverside walk. Your budget file is saved."]
        XCTAssertTrue(answer.waitForExistence(timeout: 40), app.debugDescription)
        reveal(answer); capture("app-content-native-answer"); request("/verify")
    }

    func testSwipeToReply() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated swipe reply fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func tap(_ label: String) {
            let element = app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); element.tap()
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription); key.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { key.tap() }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        key.typeText("native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription); tap("Pause companion")
        let draft = "Noon sounds lovely. I will bring the picnic."
        XCTAssertEqual(composer.value as? String, draft)
        XCTAssertTrue(app.buttons["Open Picnic note.txt"].exists, app.debugDescription)
        let original = app.staticTexts["Shall we meet at noon by the river?"].firstMatch
        XCTAssertTrue(original.waitForExistence(timeout: 15), app.debugDescription)
        func swipe(_ distance: CGFloat) {
            XCTAssertTrue(original.isHittable, app.debugDescription)
            let start = original.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
            start.press(forDuration: 0.02, thenDragTo: start.withOffset(CGVector(dx: distance, dy: 0)), withVelocity: .fast, thenHoldForDuration: 0)
        }
        swipe(28)
        XCTAssertFalse(app.buttons["Cancel reply"].exists, app.debugDescription)
        swipe(105)
        XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, draft)
        XCTAssertTrue(app.buttons["Open Picnic note.txt"].exists, app.debugDescription)
        capture("swipe-reply-native-draft"); request("/previewed")
        tap("Cancel reply")
        XCTAssertEqual(composer.value as? String, draft)
        XCTAssertFalse(app.buttons["Cancel reply"].exists)
        swipe(105)
        XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 10), app.debugDescription)
        tap("Send message")
        let answer = app.staticTexts["Noon by the river it is. Your picnic note is attached."]
        XCTAssertTrue(answer.waitForExistence(timeout: 40), app.debugDescription)
        capture("swipe-reply-native-sent"); request("/verify")
    }

    func testReadPdfDocument() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated PDF reader fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func tap(_ label: String) {
            let element = app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); element.tap()
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription); key.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { key.tap() }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        key.typeText("native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription); tap("Pause companion")
        composer.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeText("When is the visit, and what should I bring?")
        tap("Files")
        let file = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Riverbank visit.pdf")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 15), app.debugDescription); file.tap()
        XCTAssertTrue(app.buttons["Ask about this"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.otherElements["Riverbank visit.pdf, page 1"].waitForExistence(timeout: 20), app.debugDescription)
        tap("Next PDF page"); XCTAssertTrue(app.otherElements["Riverbank visit.pdf, page 2"].waitForExistence(timeout: 10), app.debugDescription)
        tap("Next PDF page"); XCTAssertTrue(app.otherElements["Riverbank visit.pdf, page 3"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.buttons["Next PDF page"].isEnabled)
        let renderDone = NSPredicate { _, _ in !app.staticTexts["Rendering document…"].exists }
        expectation(for: renderDone, evaluatedWith: nil); waitForExpectations(timeout: 20)
        capture("pdf-reader-native-preview"); tap("Ask about this")
        XCTAssertTrue(composer.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "When is the visit, and what should I bring?")
        XCTAssertTrue(app.buttons["Open Riverbank visit.pdf"].waitForExistence(timeout: 10), app.debugDescription)
        tap("Open Riverbank visit.pdf"); tap("Ask about this")
        XCTAssertEqual(app.buttons.matching(identifier: "Remove attachment").count, 1)
        tap("Files"); tap("Back to chat")
        XCTAssertEqual(composer.value as? String, "When is the visit, and what should I bring?")
        request("/previewed")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "When is the visit, and what should I bring?")
        XCTAssertTrue(app.buttons["Open Riverbank visit.pdf"].exists, app.debugDescription)
        capture("pdf-reader-native-draft"); tap("Send message")
        let answer = app.staticTexts.matching(NSPredicate(format: "label == %@", "Meet at 9:00 am and return at 3:30 pm (page 1). Bring a water bottle and packed lunch (page 2), plus the green notebook shown on page 3.")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 40), app.debugDescription)
        capture("pdf-reader-native-answer"); request("/verify")
    }

    func testReadVideoAttachment() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated video reader fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func tap(_ label: String) {
            let element = app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); element.tap()
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription); key.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { key.tap() }; key.typeText("native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription); tap("Pause companion")
        composer.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeText("What changes in this clip, and what does its soundtrack say?")
        tap("Files")
        let file = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Color study.mp4")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 15), app.debugDescription); file.tap()
        XCTAssertTrue(app.buttons["Ask about this"].waitForExistence(timeout: 15), app.debugDescription)
        capture("video-reader-native-preview"); tap("Ask about this")
        XCTAssertTrue(composer.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "What changes in this clip, and what does its soundtrack say?")
        XCTAssertTrue(app.buttons["Open Color study.mp4"].waitForExistence(timeout: 10), app.debugDescription)
        tap("Open Color study.mp4"); tap("Ask about this")
        XCTAssertEqual(app.buttons.matching(identifier: "Remove attachment").count, 1)
        tap("Files"); tap("Back to chat")
        XCTAssertEqual(composer.value as? String, "What changes in this clip, and what does its soundtrack say?")
        request("/previewed")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "What changes in this clip, and what does its soundtrack say?")
        XCTAssertTrue(app.buttons["Open Color study.mp4"].exists, app.debugDescription)
        capture("video-reader-native-draft"); tap("Send message")
        let answer = app.staticTexts.matching(NSPredicate(format: "label == %@", "The sampled frames are red near 0.5s, blue near 2.5s, and green near 4.5s. The soundtrack transcript says: “Meet by the river at noon.”")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 40), app.debugDescription)
        capture("video-reader-native-answer"); request("/verify")
    }

    func testAskAboutSavedFile() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated saved-file fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func tap(_ label: String) {
            let element = app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); element.tap()
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription); key.tap(); key.typeText("native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription); tap("Pause companion")
        composer.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeText("What should I bring?")
        tap("Files")
        let file = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Weekend plans.txt")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 15), app.debugDescription); file.tap()
        XCTAssertTrue(app.buttons["Ask about this"].waitForExistence(timeout: 15), app.debugDescription)
        capture("ask-file-native-preview"); tap("Ask about this")
        XCTAssertTrue(composer.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "What should I bring?")
        XCTAssertTrue(app.buttons["Open Weekend plans.txt"].waitForExistence(timeout: 10), app.debugDescription)
        tap("Open Weekend plans.txt"); tap("Ask about this")
        XCTAssertEqual(app.buttons.matching(identifier: "Remove attachment").count, 1)
        tap("Files"); tap("Back to chat")
        XCTAssertEqual(composer.value as? String, "What should I bring?")
        request("/previewed")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "What should I bring?")
        XCTAssertTrue(app.buttons["Open Weekend plans.txt"].exists, app.debugDescription)
        capture("ask-file-native-draft"); tap("Send message")
        let answer = app.staticTexts["Your saved plan says to meet at noon and bring a book."]
        XCTAssertTrue(answer.waitForExistence(timeout: 40), app.debugDescription)
        capture("ask-file-native-answer"); request("/verify")
    }

    func testDirectDocumentConversation() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated document fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func tap(_ label: String) {
            let element = app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 25), app.debugDescription); element.tap()
        }
        func fill(_ element: XCUIElement, _ value: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(value)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription); tap("Pause companion")
        fill(composer, "Where is my meeting and what should I bring?")
        for name in ["Meeting note.txt", "Meeting place.pdf", "Supplies.docx"] {
            tap("Files")
            let file = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
            XCTAssertTrue(file.waitForExistence(timeout: 15), app.debugDescription); file.tap()
            tap("Ask about this")
            XCTAssertTrue(composer.waitForExistence(timeout: 15), app.debugDescription)
            XCTAssertEqual(composer.value as? String, "Where is my meeting and what should I bring?")
        }
        XCTAssertEqual(app.buttons.matching(identifier: "Remove attachment").count, 3)
        tap("Files"); tap("Back to chat"); request("/previewed")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Where is my meeting and what should I bring?")
        XCTAssertEqual(app.buttons.matching(identifier: "Remove attachment").count, 3)
        tap("Send message")
        let answer = app.staticTexts["Your meeting is at Willow library. Bring a green notebook."]
        XCTAssertTrue(answer.waitForExistence(timeout: 40), app.debugDescription)
        app.terminate(); app.launch()
        fill(composer, "Remind me what I should bring."); tap("Send message")
        request("/verify")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "direct-document-native-chat"; shot.lifetime = .keepAlways; add(shot)
    }

    func testSavedEmailAndEnclosedFile() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated email fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            for _ in 0..<8 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 70
                if element.isHittable && element.frame.maxY < bottom - 8 { return }
                let upward = element.frame.minY < 145
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: upward ? 0.3 : 0.73)).press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: upward ? 0.75 : 0.25)))
            }
        }
        func tap(_ label: String) {
            let element = app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); reveal(element); element.tap()
        }
        func fill(_ element: XCUIElement, _ value: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription); tap("Pause companion")
        tap("Open Weekend.eml")
        XCTAssertTrue(app.staticTexts["Weekend — plan"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Café Team <team@example.invalid>"].exists, app.debugDescription)
        capture("email-native-preview")
        tap("Open attachment Budget.csv")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Train,25")).firstMatch.waitForExistence(timeout: 15), app.debugDescription)
        tap("Save Budget.csv")
        let browse = app.buttons["Browse"]
        XCTAssertTrue(browse.waitForExistence(timeout: 15), app.debugDescription)
        browse.tap()
        let cancel = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Cancel")).firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 15), app.debugDescription)
        capture("email-native-save-picker")
        // The remote Files AX node misreports Cancel at the overflow button.
        // The captured Browse sheet puts its visible close button at top left.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.095, dy: 0.126)).tap()
        let returned = NSPredicate { _, _ in app.buttons["Save Budget.csv"].isEnabled }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: returned, object: nil)], timeout: 15), .completed, app.debugDescription)
        tap("Back to email"); tap("Open attachment Budget.csv")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Tea,8")).firstMatch.waitForExistence(timeout: 15), app.debugDescription)
        capture("email-native-attachment")
        tap("Back to email"); tap("Back to chat"); request("/previewed")
        fill(composer, "Read this email and its budget.")
        tap("Files"); tap("Back to chat")
        XCTAssertEqual(composer.value as? String, "Read this email and its budget.")
        tap("Send message")
        XCTAssertTrue(app.staticTexts["The email says noon. The attached budget lists train 25 and tea 8."].waitForExistence(timeout: 45), app.debugDescription)
        capture("email-native-result"); request("/verify")
    }

    func testMediaPlaybackAndAudioRead() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated media fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            for _ in 0..<8 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 70
                if element.isHittable && element.frame.maxY < bottom - 8 { return }
                let upward = element.frame.minY < 145
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: upward ? 0.3 : 0.73)).press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: upward ? 0.75 : 0.25)))
            }
        }
        func tap(_ label: String) {
            let element = app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); reveal(element); element.tap()
        }
        func fill(_ element: XCUIElement, _ value: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription); tap("Pause companion")
        tap("Play Garden.mp4")
        XCTAssertTrue(app.buttons["Pause Garden.mp4"].waitForExistence(timeout: 10), app.debugDescription)
        let progressing = NSPredicate { _, _ in
            let value = app.sliders["Garden.mp4 position"].value as? String ?? "0"
            return (Double(value) ?? 0) > 0.2
        }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: progressing, object: nil)], timeout: 8), .completed, app.debugDescription)
        tap("Mute Garden.mp4"); XCTAssertTrue(app.buttons["Unmute Garden.mp4"].exists)
        tap("Pause Garden.mp4")
        let position = app.sliders["Garden.mp4 position"]; XCTAssertTrue(position.exists, app.debugDescription); reveal(position)
        // WebKit range inputs do not publish UIKit scrubber geometry. Use the
        // actual element's midpoint, then independently check its resulting time.
        position.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let seeked = NSPredicate { _, _ in
            let value = Double(position.value as? String ?? "0") ?? 0
            return value > 5 && value < 7
        }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: seeked, object: nil)], timeout: 8), .completed, app.debugDescription)
        tap("Play Garden.mp4")
        capture("media-native-video-playing")
        tap("Play Lunch.wav"); XCTAssertTrue(app.buttons["Pause Lunch.wav"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["Play Garden.mp4"].exists, app.debugDescription)
        tap("Open Garden.mp4")
        tap("Play Garden.mp4"); XCTAssertTrue(app.buttons["Pause Garden.mp4"].waitForExistence(timeout: 10), app.debugDescription)
        capture("media-native-video-preview"); tap("Back to chat")
        tap("Play Lunch.wav"); tap("Files"); tap("Back to chat")
        XCTAssertTrue(app.buttons["Play Lunch.wav"].waitForExistence(timeout: 10), app.debugDescription)
        request("/previewed")
        fill(composer, "What does my recording say?")
        tap("Files"); tap("Back to chat"); XCTAssertEqual(composer.value as? String, "What does my recording say?")
        tap("Send message")
        XCTAssertTrue(app.staticTexts["Your recording says: a quiet lunch at noon, followed by a walk."].waitForExistence(timeout: 45), app.debugDescription)
        capture("media-native-transcribed"); request("/verify")
    }

    func testSkillRepositoryReviewAndRun() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated skill file fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            for _ in 0..<8 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 70
                if element.isHittable && element.frame.maxY < bottom - 8 { return }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.73)).press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.25)))
            }
        }
        func tap(_ label: String) {
            let element = app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); reveal(element); element.tap()
        }
        func fill(_ element: XCUIElement, _ value: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        tap("Pause companion"); fill(composer, "Keep my native repository draft")
        tap("More"); tap("Skills"); tap("Import skill")
        let link = app.textFields["GitHub skill link"]
        fill(link, "https://github.com/relay-tests/methods/tree/main/calm-plan")
        request("/slow"); tap("Load skill")
        if !app.buttons["Cancel download"].waitForExistence(timeout: 3) { tap("Load skill") }
        tap("Cancel download")
        XCTAssertTrue(app.buttons["Load skill"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(link.value as? String, "https://github.com/relay-tests/methods/tree/main/calm-plan")
        request("/cancelled"); capture("skill-repository-native-cancelled")
        tap("Load skill")
        XCTAssertTrue(app.textFields["Shortcut"].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(app.textFields["Shortcut"].value as? String, "calm-plan-2")
        XCTAssertTrue(app.links["relay-tests/methods · 1111111"].exists, app.debugDescription)
        XCTAssertEqual(app.alerts.count, 0)
        request("/reviewed"); capture("skill-repository-native-review")
        tap("Add skill"); request("/saved")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native repository draft")
        tap("More"); tap("Skills"); tap("Run skill")
        fill(app.textViews["Anything for this run?"], "Sunday"); tap("Run in this chat")
        XCTAssertTrue(app.staticTexts["One calm idea: a quiet tea break."].waitForExistence(timeout: 45), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native repository draft")
        capture("skill-repository-native-run"); request("/verify")
    }

    func testSkillFileReviewAndRun() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated skill file fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            for _ in 0..<8 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 70
                if element.isHittable && element.frame.maxY < bottom - 8 { return }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.73)).press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.25)))
            }
        }
        func tap(_ label: String) {
            let element = app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); reveal(element); element.tap()
        }
        func fill(_ element: XCUIElement, _ value: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        tap("Pause companion"); fill(composer, "Keep my native skill draft")
        tap("More"); tap("Skills"); tap("Import skill"); tap("Paste instructions")
        fill(app.textViews["Skill file"], "---\nname: calm-plan\ndescription: Plan a quiet day.\nlicense: MIT\nmetadata:\n  author: Relay acceptance\n---\n\nAsk which day. Suggest three calm activities.")
        tap("Review skill")
        // A keyboard dismissal can relocate the button before UIKit dispatches
        // its touch. Re-target the still-visible review action after that transition.
        if !app.textFields["Shortcut"].waitForExistence(timeout: 3) {
            XCTAssertFalse(app.keyboards.firstMatch.exists, app.debugDescription)
            tap("Review skill")
        }
        XCTAssertTrue(app.textFields["Shortcut"].waitForExistence(timeout: 10), app.debugDescription)
        request("/reviewed")
        XCTAssertEqual(app.textFields["Shortcut"].value as? String, "calm-plan-2")
        capture("skill-file-native-review"); tap("Add skill")
        tap("Edit skill")
        XCTAssertTrue(app.textViews["Instructions"].waitForExistence(timeout: 20), app.debugDescription)
        fill(app.textViews["Instructions"], " Native method marker 42."); tap("Save skill"); request("/edited")
        tap("Share skill"); tap("Review skill"); capture("skill-file-native-export")
        tap("Save reviewed skill")
        let picker = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Cancel")).firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 20), app.debugDescription)
        capture("skill-file-native-save-picker")
        // iOS 26's remote Files view omits its visible Save button from this
        // application's AX tree. The captured On My iPhone sheet places it here.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.875, dy: 0.126)).tap()
        XCTAssertTrue(app.staticTexts["File saved."].waitForExistence(timeout: 20), app.debugDescription)
        capture("skill-file-native-saved")
        tap("Back to skills"); tap("Run skill")
        fill(app.textViews["Anything for this run?"], "Sunday"); tap("Run in this chat")
        XCTAssertTrue(app.staticTexts["Your saved calm plan method is ready."].waitForExistence(timeout: 45), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native skill draft")
        capture("skill-file-native-run"); request("/verify")
    }

    func testSkillPackageReviewAndRun() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated skill file fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            for _ in 0..<8 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 70
                if element.isHittable && element.frame.maxY < bottom - 8 { return }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.73)).press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.25)))
            }
        }
        func tap(_ label: String) {
            let element = app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); reveal(element); element.tap()
        }
        func fill(_ element: XCUIElement, _ value: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        tap("Pause companion"); fill(composer, "Keep my native packing draft")
        tap("More"); tap("Skills")
        tap("4 supporting files")
        let reference = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "references/guide.md")).firstMatch
        XCTAssertTrue(reference.waitForExistence(timeout: 20), app.debugDescription); reveal(reference); reference.tap()
        capture("skill-package-native-files"); request("/reviewed")
        tap("Edit skill")
        XCTAssertTrue(app.textViews["Instructions"].waitForExistence(timeout: 20), app.debugDescription)
        fill(app.textViews["Instructions"], " Native method marker 42."); tap("Save skill"); request("/edited")
        tap("Share skill"); tap("Review skill"); capture("skill-package-native-export")
        tap("Save reviewed skill")
        let picker = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Cancel")).firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 20), app.debugDescription)
        capture("skill-package-native-save-picker")
        // iOS 26's remote Files view omits its visible Save button from this
        // application's AX tree. The captured On My iPhone sheet places it here.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.875, dy: 0.126)).tap()
        XCTAssertTrue(app.staticTexts["File saved."].waitForExistence(timeout: 20), app.debugDescription)
        capture("skill-package-native-saved")
        tap("Back to skills"); tap("Run skill")
        fill(app.textViews["Anything for this run?"], "Sunday"); tap("Run in this chat")
        XCTAssertTrue(app.staticTexts["Your packing list has 3 items. I saved the checked list as packing-list.csv."].waitForExistence(timeout: 90), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native packing draft")
        capture("skill-package-native-run"); request("/verify")
    }

    func testNativeVoiceCall() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated native voice fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            for _ in 0..<8 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 70
                if element.isHittable && element.frame.maxY < bottom - 8 { return }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.73)).press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.25)))
            }
        }
        func tap(_ label: String) {
            let element = app.switches[label].exists ? app.switches[label] : app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); reveal(element); element.tap()
        }
        func fill(_ element: XCUIElement, _ value: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        tap("Pause companion")
        request("/deny"); tap("Start voice chat")
        let denied = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Microphone access was not allowed")).firstMatch
        XCTAssertTrue(denied.waitForExistence(timeout: 20), app.debugDescription)
        capture("voice-native-denied"); tap("End call"); request("/allow")
        tap("Start voice chat")
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 20), app.debugDescription)
        request("/listening"); capture("voice-native-listening")
        request("/pulse")
        XCTAssertTrue(app.staticTexts["Relay is speaking"].waitForExistence(timeout: 30), app.debugDescription)
        capture("voice-native-speaking")
        request("/pulse")
        XCTAssertTrue(app.staticTexts["Native spoken reply 2. Your quiet plan is saved in this chat."].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Relay is speaking"].waitForExistence(timeout: 20), app.debugDescription)
        tap("Interrupt")
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 15), app.debugDescription)
        tap("Mute microphone"); request("/muted-pulse"); request("/muted-check")
        capture("voice-native-muted"); tap("Unmute microphone")
        request("/fail-pulse")
        XCTAssertTrue(app.buttons["Retry this turn"].waitForExistence(timeout: 30), app.debugDescription)
        capture("voice-native-retry"); request("/retry"); tap("Retry this turn")
        XCTAssertTrue(app.staticTexts["Native spoken reply 3. Your quiet plan is saved in this chat."].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Relay is speaking"].waitForExistence(timeout: 20), app.debugDescription)
        tap("End call"); request("/ended"); capture("voice-native-ended")
        tap("Start voice chat")
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 20), app.debugDescription)
        fill(composer, "Keep my native voice draft")
        XCUIDevice.shared.press(.home); request("/background")
        app.activate()
        XCTAssertTrue(composer.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertFalse(app.buttons["End call"].exists, app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native voice draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native voice draft")
        XCTAssertFalse(app.buttons["End call"].exists, app.debugDescription)
        capture("voice-native-relaunch")
        request("/memo-ready")
        let play = app.buttons.matching(identifier: "Play voice memo").allElementsBoundByIndex.last!
        reveal(play); play.tap(); request("/memo-playing")
        capture("voice-native-compact-replay")
        tap("Pause voice memo"); request("/memo-stopped")
        for mode in ["noise", "speech-failure"] {
            tap("Start voice chat")
            XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 20), app.debugDescription)
            request("/" + mode + "-start")
            if mode == "noise" {
                request("/short-noise")
            } else {
                XCTAssertTrue(app.buttons["Keep talking"].waitForExistence(timeout: 30), app.debugDescription)
                capture("voice-native-speech-failure"); tap("Keep talking")
            }
            XCTAssertTrue(app.staticTexts["Relay is speaking"].waitForExistence(timeout: 30), app.debugDescription)
            request("/recovered"); capture("voice-native-" + mode + "-recovered")
            tap("End call"); request("/recovery-ended")
            XCTAssertEqual(composer.value as? String, "Keep my native voice draft")
        }
        tap("Start voice chat")
        XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 20), app.debugDescription)
        request("/navigation-start"); tap("Files"); request("/navigation-ended")
        XCTAssertFalse(app.buttons["End call"].exists, app.debugDescription)
        XCTAssertTrue(app.buttons["Back to chat"].waitForExistence(timeout: 20), app.debugDescription)
        capture("voice-native-page-loading")
        tap("Back to chat")
        XCTAssertTrue(composer.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native voice draft")
        XCTAssertFalse(app.buttons["End call"].exists, app.debugDescription)
        request("/navigation-returned"); capture("voice-native-returned")
        request("/verify")
    }

    func testRedirectCurrentRequest() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated follow-up fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            for _ in 0..<8 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 70
                if element.isHittable && element.frame.maxY < bottom - 8 { return }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.73)).press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.25)))
            }
        }
        func tap(_ label: String) {
            let element = app.switches[label].exists ? app.switches[label] : app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); reveal(element); element.tap()
        }
        func fill(_ element: XCUIElement, _ value: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        tap("Pause companion")
        fill(composer, "Plan the weekend."); tap("Send message"); request("/waiting")
        XCTAssertTrue(app.buttons["Stop reply"].waitForExistence(timeout: 15), app.debugDescription)
        fill(composer, "Make it Sunday instead and use the attached notes.")
        tap("Files")
        let note = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "garden-notes.txt")).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 15), app.debugDescription); reveal(note); note.tap()
        tap("Ask about this")
        XCTAssertEqual(composer.value as? String, "Make it Sunday instead and use the attached notes.")
        XCTAssertTrue(app.buttons["Open garden-notes.txt"].exists)
        XCTAssertTrue(app.buttons["Send message"].exists)
        XCTAssertTrue(app.buttons["Queue follow-up"].exists)
        XCTAssertTrue(app.buttons["Stop reply"].isHittable)
        XCTAssertGreaterThanOrEqual(app.buttons["Stop reply"].frame.height, 44)
        capture("steering-native-compose"); tap("Send message"); request("/steered")
        fill(composer, "Afterward, give me a packing list."); tap("Queue follow-up")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "follow-up")).firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        request("/queued")
        let updated = app.staticTexts["Your Sunday plan uses the attached notes: meet at the garden at 10."]
        let packing = app.staticTexts["Your packing list: water, a notebook, and a light jacket."]
        XCTAssertTrue(updated.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(packing.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertFalse(app.staticTexts["Obsolete Saturday plan."].exists)
        fill(composer, "Keep my native follow-up draft")
        tap("Files"); tap("Back to chat")
        XCTAssertEqual(composer.value as? String, "Keep my native follow-up draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native follow-up draft")
        XCTAssertTrue(packing.exists)
        capture("steering-native-relaunch"); request("/verify")
    }

    func testDirectMessagePriority() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated priority fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            for _ in 0..<8 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 70
                if element.isHittable && element.frame.maxY < bottom - 8 { return }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.73)).press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.25)))
            }
        }
        func tap(_ label: String) {
            let element = app.switches[label].exists ? app.switches[label] : app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); reveal(element); element.tap()
        }
        func fill(_ element: XCUIElement, _ value: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        tap("Pause companion")
        fill(composer, "Can you help me now?"); tap("Send message"); request("/priority")
        let reply = app.staticTexts["Of course. What do you need?"]
        XCTAssertTrue(reply.waitForExistence(timeout: 20), app.debugDescription)
        fill(composer, "Keep my native priority draft")
        tap("Files"); tap("Back to chat")
        XCTAssertEqual(composer.value as? String, "Keep my native priority draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native priority draft")
        XCTAssertTrue(reply.exists)
        capture("work-priority-native-relaunch")
        request("/verify")
    }

    func testTeachTaskFromChat() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated teaching fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 110)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            if !app.buttons["Back to chat"].exists && element.isHittable { return }
            for _ in 0..<8 {
                // The workspace dock sits above the keyboard and can cover an AX-hittable control.
                let keyboardTop = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 30
                let dockTop = app.buttons["More"].exists ? app.buttons["More"].frame.minY - 25 : app.frame.maxY - 30
                let bottom = min(keyboardTop, dockTop)
                let top = app.buttons["Back to chat"].exists ? app.buttons["Back to chat"].frame.maxY + 8 : 155
                if element.isHittable && (element.frame.maxY < 155 || (element.frame.minY > top && element.frame.maxY < bottom - 8)) { return }
                let above = element.frame.minY < top
                let startY = above ? top + 25 : bottom - 18
                let endY = above ? bottom - 18 : top + 25
                let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
                origin.withOffset(CGVector(dx: app.frame.width * 0.98, dy: startY)).press(forDuration: 0.05,
                    thenDragTo: origin.withOffset(CGVector(dx: app.frame.width * 0.98, dy: endY)))
            }
        }
        func tap(_ label: String) {
            let element = app.buttons[label].exists ? app.buttons[label] : app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); reveal(element); element.tap()
        }
        func fill(_ element: XCUIElement, _ value: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        tap("Pause companion")
        fill(composer, "Keep my Main native draft")
        tap("Show chats"); tap("New side chat")
        fill(composer, "Keep my native teaching draft"); request("/stage")
        tap("Add to chat"); capture("teaching-entry-native-menu")
        tap("Teach a task"); request("/entry")
        fill(app.textFields["What are you showing Relay?"], "Create a note from its title")
        capture("teaching-entry-native-ready")
        tap("Take control & record")
        XCTAssertTrue(app.buttons["Stop & review"].waitForExistence(timeout: 60), app.debugDescription)
        fill(app.textFields["Type on the computer"], "Demo native-ios")
        tap("Type text"); tap("Enter"); tap("Capture this step"); tap("Stop & review")
        capture("teaching-entry-native-review")
        tap("Create skill draft")
        XCTAssertTrue(app.textViews["Review the method"].waitForExistence(timeout: 60), app.debugDescription)
        tap("Save reviewed skill"); tap("Give back & test skill")
        request("/completed")
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native teaching draft")
        let output = app.staticTexts["The learned method created and checked your test note."]
        XCTAssertTrue(output.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(app.buttons["Open Unsent-native.txt"].exists, app.debugDescription)
        capture("teaching-entry-native-result")
        tap("Back to main chat")
        XCTAssertEqual(composer.value as? String, "Keep my Main native draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my Main native draft")
        request("/verify")
    }

    func testStopWorkFromChat() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else { throw XCTSkip("Run the isolated stop fixture.") }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            for _ in 0..<8 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 70
                if element.isHittable && element.frame.maxY < bottom - 8 { return }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.73)).press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.25)))
            }
        }
        func tap(_ label: String) {
            let element = app.switches[label].exists ? app.switches[label] : app.buttons[label]; XCTAssertTrue(element.waitForExistence(timeout: 20), app.debugDescription); reveal(element); element.tap()
        }
        func fill(_ element: XCUIElement, _ value: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); tap("Open workspace")
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        tap("Pause companion")
        fill(composer, "Make a travel plan."); tap("Send message"); request("/waiting")
        fill(composer, "Write a packing list afterward."); tap("Queue follow-up")
        fill(composer, "Stop now"); tap("Send message"); request("/stopped")
        let stopped = app.staticTexts["Stopped work in this chat. Queued follow-ups are paused."]
        XCTAssertTrue(stopped.waitForExistence(timeout: 20), app.debugDescription)
        fill(composer, "Keep my native stop draft")
        tap("Files"); tap("Back to chat")
        XCTAssertEqual(composer.value as? String, "Keep my native stop draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native stop draft")
        XCTAssertTrue(stopped.exists)
        capture("chat-stop-native-relaunch")
        tap("Send queued messages")
        XCTAssertTrue(app.staticTexts["Your queued packing list is ready."].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native stop draft")
        XCTAssertFalse(app.staticTexts["A late obsolete plan."].exists)
        capture("chat-stop-native-resumed"); request("/verify")
    }

    func testLocalToolConnectionAndReviewedWrite() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated local tool fixture.")
        }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            for _ in 0..<8 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY - 70
                if element.isHittable && element.frame.maxY < bottom - 8 { return }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.73)).press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.25)))
            }
        }
        func fill(_ element: XCUIElement, _ value: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(value)
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["Pause companion"].tap()
        fill(composer, "Keep my native local tool draft")
        app.buttons["More"].tap()
        let apps = app.buttons["Connect apps"]; XCTAssertTrue(apps.waitForExistence(timeout: 15), app.debugDescription); reveal(apps); apps.tap()
        let addApp = app.buttons["Add an app"]; XCTAssertTrue(addApp.waitForExistence(timeout: 15)); addApp.tap()
        let advanced = app.buttons["Other connection options"]; reveal(advanced); advanced.tap()
        let local = app.buttons["Use a program in Relay’s computer"]; reveal(local); local.tap()
        fill(app.textFields["Program"], "python3")
        fill(app.textViews["Arguments"], "/workspace/local-tools.py")
        capture("local-tools-native-setup")
        let launch = app.buttons["Run and find tools"]; reveal(launch); launch.tap()
        let connect = app.buttons["Connect selected tools"]
        XCTAssertTrue(connect.waitForExistence(timeout: 45), app.debugDescription)
        request("/unconnected")
        let reads = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Allow trusted read tools without review")).firstMatch
        XCTAssertTrue(reads.waitForExistence(timeout: 10), app.debugDescription); reveal(reads); reads.tap()
        reveal(connect); connect.tap()
        XCTAssertTrue(app.buttons["Manage python3"].waitForExistence(timeout: 20), app.debugDescription)
        app.buttons["Back to chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my native local tool draft")
        fill(composer, " Read my local note and save a calm Sunday plan.")
        app.buttons["Send message"].tap()
        let approve = app.buttons["Approve app action"]
        XCTAssertTrue(approve.waitForExistence(timeout: 60), app.debugDescription); reveal(approve)
        capture("local-tools-native-review"); approve.tap()
        XCTAssertTrue(app.staticTexts["Your local note is saved."].waitForExistence(timeout: 60), app.debugDescription)
        capture("local-tools-native-result"); request("/verify")
    }

    func testLocalModelDownloadAndConversation() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated local-download fixture.")
        }
        func request(_ path: String) -> String {
            let done = expectation(description: path); var result = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 30); return result
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<12 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 150
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY))
                let end = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY))
                start.press(forDuration: 0.05, thenDragTo: end)
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func fill(_ field: XCUIElement, _ value: String) {
            field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(value)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription)
        fill(key, "native-fixture-owner-key-24-characters"); app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my native download draft")
        app.buttons["Self-hosted sample"].tap()
        XCTAssertEqual(request("/before"), "ok")
        func tap(_ label: String) { let button = app.buttons[label]; reveal(button); button.tap() }
        tap("Use a local model"); tap("Download · about 4 GB")
        XCTAssertTrue(app.buttons["Cancel download"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(request("/progress"), "ok")
        let progress = XCTAttachment(screenshot: app.screenshot()); progress.name = "local-model-download-native-iphone-progress"; progress.lifetime = .keepAlways; add(progress)
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native download draft")
        app.buttons["Self-hosted sample"].tap(); tap("Use a local model")
        tap("Cancel download")
        XCTAssertTrue(app.staticTexts["Download cancelled. Ollama may keep downloaded parts for a retry."].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertEqual(request("/cancelled"), "ok")
        tap("Download · about 4 GB")
        XCTAssertTrue(app.buttons["Cancel download"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(request("/finish"), "ok")
        tap("Use this model")
        XCTAssertTrue(app.buttons["Edit Ollama · qwen3.5:4b"].waitForExistence(timeout: 15), app.debugDescription)
        app.buttons["Back to chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my native download draft")
        composer.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeKey("a", modifierFlags: .command); composer.typeText("Hello from my downloaded model")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["Your downloaded model is connected."].waitForExistence(timeout: 30), app.debugDescription)
        fill(composer, "Keep my final native download draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my final native download draft")
        XCTAssertEqual(request("/verify"), "ok")
        let final = XCTAttachment(screenshot: app.screenshot()); final.name = "local-model-download-native-iphone-reply"; final.lifetime = .keepAlways; add(final)
    }

    func testModelCapabilitiesAndConversation() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated model-abilities fixture.")
        }
        func request(_ path: String) -> String {
            let done = expectation(description: path); var result = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 30); return result
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<12 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 150
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY))
                let end = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY))
                start.press(forDuration: 0.05, thenDragTo: end)
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func fill(_ field: XCUIElement, _ value: String) {
            field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(value)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription)
        fill(key, "native-fixture-owner-key-24-characters"); app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my native abilities draft")
        app.buttons["Self-hosted sample"].tap()
        XCTAssertEqual(request("/before"), "ok")
        func tap(_ label: String) { let button = app.buttons[label]; reveal(button); button.tap() }
        tap("Use a local model")
        XCTAssertTrue(app.staticTexts["Chat & documents · Attach text, PDF or Office files and ask. Photos, apps and assistant actions need a suitable model."].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(request("/detected"), "ok")
        tap("Use this model")
        XCTAssertTrue(app.buttons["Edit Ollama · text-chat"].waitForExistence(timeout: 15), app.debugDescription)
        app.buttons["Back to chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my native abilities draft")
        composer.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeKey("a", modifierFlags: .command); composer.typeText("Hello, Relay!")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["Hello! We can chat here without tools."].waitForExistence(timeout: 30), app.debugDescription)
        fill(composer, "Keep my final native abilities draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my final native abilities draft")
        XCTAssertEqual(request("/verify"), "ok")
    }

    func testDirectPhotoConversation() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated model-abilities fixture.")
        }
        func request(_ path: String, data: Data? = nil) -> String {
            let done = expectation(description: path); var result = ""
            var request = URLRequest(url: URL(string: control + path)!)
            if let data = data { request.httpMethod = "POST"; request.httpBody = data }
            URLSession.shared.dataTask(with: request) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 30); return result
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        let image = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 40)).image { context in
            UIColor.systemGreen.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 40))
        }
        let png = try XCTUnwrap(image.pngData())
        XCTAssertEqual(request("/paste-fixture", data: png), "ok")
        app.launchArguments = ["-relay-server", server, "--relay-paste-ui-test"]
        app.launchEnvironment["RELAY_PASTE_TEST_IMAGE"] = png.base64EncodedString()
        app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<12 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 150
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY))
                let end = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY))
                start.press(forDuration: 0.05, thenDragTo: end)
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func fill(_ field: XCUIElement, _ value: String) {
            field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(value)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription)
        fill(key, "native-fixture-owner-key-24-characters"); app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Describe my pasted photo")
        app.buttons["Self-hosted sample"].tap()
        XCTAssertEqual(request("/before"), "ok")
        func tap(_ label: String) { let button = app.buttons[label]; reveal(button); button.tap() }
        tap("Use a local model")
        XCTAssertTrue(app.staticTexts["Chat, photos & documents · Attach a file and ask. Apps and assistant actions need a model with tools."].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(request("/detected"), "ok")
        tap("Use this model")
        XCTAssertTrue(app.buttons["Edit Ollama · photo-chat"].waitForExistence(timeout: 15), app.debugDescription)
        app.buttons["Back to chat"].tap()
        XCTAssertEqual(composer.value as? String, "Describe my pasted photo")
        app.buttons["Copy test image"].tap()
        composer.press(forDuration: 1.2)
        let paste = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Paste")).firstMatch
        if !paste.waitForExistence(timeout: 3) { composer.tap() }
        XCTAssertTrue(paste.waitForExistence(timeout: 10), app.debugDescription); paste.tap()
        let allow = app.buttons["Allow Paste"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        XCTAssertTrue(app.buttons["Remove attachment"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(request("/draft"), "ok")
        app.terminate(); app.launchArguments = ["-relay-server", server]; app.launchEnvironment = [:]; app.launch()
        XCTAssertTrue(app.buttons["Remove attachment"].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Describe my pasted photo")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["I received 1 attached photos directly."].waitForExistence(timeout: 30), app.debugDescription)
        fill(composer, "What color is it?")
        app.buttons["Send message"].tap()
        XCTAssertEqual(request("/followup"), "ok")
        fill(composer, "Keep my final native photo draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my final native photo draft")
        XCTAssertEqual(request("/verify"), "ok")
    }

    func testLocalModelStartupAndConversation() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated installed-Ollama fixture.")
        }
        func request(_ path: String) -> String {
            let done = expectation(description: path); var result = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 30); return result
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<12 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 150
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY))
                let end = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY))
                start.press(forDuration: 0.05, thenDragTo: end)
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func fill(_ field: XCUIElement, _ value: String) {
            field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(value)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription)
        fill(key, "native-fixture-owner-key-24-characters"); app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my native startup draft")
        app.buttons["Self-hosted sample"].tap()
        XCTAssertEqual(request("/before"), "ok")
        func tap(_ label: String) { let button = app.buttons[label]; reveal(button); button.tap() }
        tap("Use a local model"); tap("Start Ollama")
        let use = app.buttons["Use this model"]
        XCTAssertTrue(use.waitForExistence(timeout: 45), app.debugDescription); reveal(use)
        XCTAssertFalse(app.secureTextFields["API key"].exists)
        XCTAssertFalse(app.textFields["Endpoint"].exists)
        XCTAssertEqual(request("/started"), "ok")
        let ready = XCTAttachment(screenshot: app.screenshot()); ready.name = "local-model-start-native-iphone-ready"; ready.lifetime = .keepAlways; add(ready)
        use.tap()
        XCTAssertTrue(app.buttons["Edit Ollama · qwen3.5:4b"].waitForExistence(timeout: 15), app.debugDescription)
        app.buttons["Back to chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my native startup draft")
        composer.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeKey("a", modifierFlags: .command)
        composer.typeText("Reply with exactly these words, without tools: Ready for today.")
        XCTAssertEqual(composer.value as? String, "Reply with exactly these words, without tools: Ready for today.")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["Ready for today."].waitForExistence(timeout: 180), app.debugDescription)
        fill(composer, "Keep my final native startup draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my final native startup draft")
        XCTAssertEqual(request("/verify"), "ok")
        let final = XCTAttachment(screenshot: app.screenshot()); final.name = "local-model-start-native-iphone-reply"; final.lifetime = .keepAlways; add(final)
    }

    func testLocalModelSetupAndConversation() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated local-model fixture.")
        }
        func request(_ path: String) -> String {
            let done = expectation(description: path); var result = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 30); return result
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<12 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 150
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY))
                let end = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY))
                start.press(forDuration: 0.05, thenDragTo: end)
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func fill(_ field: XCUIElement, _ value: String) {
            field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(value)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription)
        fill(key, "native-fixture-owner-key-24-characters"); app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my native model draft")
        app.buttons["Self-hosted sample"].tap()
        XCTAssertEqual(request("/before"), "ok")
        func tap(_ label: String) { let button = app.buttons[label]; reveal(button); button.tap() }
        tap("Use a local model")
        let use = app.buttons["Use this model"]
        reveal(use)
        XCTAssertFalse(app.secureTextFields["API key"].exists)
        XCTAssertFalse(app.textFields["Endpoint"].exists)
        XCTAssertEqual(request("/unconnected"), "ok")
        let ready = XCTAttachment(screenshot: app.screenshot()); ready.name = "local-model-setup-native-ready"; ready.lifetime = .keepAlways; add(ready)
        XCTAssertEqual(request("/empty"), "ok"); tap("Check again")
        XCTAssertTrue(app.staticTexts["Ollama is running with no models listed."].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(use.exists)
        XCTAssertEqual(request("/ready"), "ok"); tap("Check again"); tap("Use this model")
        XCTAssertTrue(app.buttons["Edit Ollama · local-chat"].waitForExistence(timeout: 15), app.debugDescription)
        tap("Use a local model"); tap("Use this model")
        XCTAssertTrue(app.buttons["Edit Ollama · local-chat"].waitForExistence(timeout: 15), app.debugDescription)
        app.buttons["Back to chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my native model draft")
        composer.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeKey("a", modifierFlags: .command)
        composer.typeText("Hello from the local model on my iPhone.")
        XCTAssertEqual(composer.value as? String, "Hello from the local model on my iPhone.")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["Your local model is connected. We can keep talking here."].waitForExistence(timeout: 30), app.debugDescription)
        fill(composer, "Keep my final native draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my final native draft")
        XCTAssertEqual(request("/verify"), "ok")
        let final = XCTAttachment(screenshot: app.screenshot()); final.name = "local-model-setup-native-result"; final.lifetime = .keepAlways; add(final)
    }

    func testModelBrowserSignInAndConversation() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated model sign-in fixture.")
        }
        func request(_ path: String) -> String {
            let done = expectation(description: path); var result = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 30); return result
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<12 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 150
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY))
                let end = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY))
                start.press(forDuration: 0.05, thenDragTo: end)
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func fill(_ field: XCUIElement, _ value: String) {
            field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(value)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription)
        fill(key, "native-fixture-owner-key-24-characters"); app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my native model draft")
        app.buttons["Self-hosted sample"].tap()
        let signIn = app.buttons["Connect OpenRouter"]; reveal(signIn)
        let entry = XCTAttachment(screenshot: app.screenshot()); entry.name = "model-sign-in-entry"; entry.lifetime = .keepAlways; add(entry)
        signIn.tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        let allow = safari.buttons["Allow Relay"]
        XCTAssertTrue(allow.waitForExistence(timeout: 40), safari.debugDescription)
        let tip = safari.popovers.buttons["Close"]; if tip.waitForExistence(timeout: 2) { tip.tap() }
        allow.tap()
        XCTAssertTrue(safari.staticTexts["OpenRouter is connected."].waitForExistence(timeout: 30), safari.debugDescription)
        let consent = XCTAttachment(screenshot: safari.screenshot()); consent.name = "model-sign-in-safari"; consent.lifetime = .keepAlways; add(consent)
        app.activate()
        let model = app.otherElements.matching(NSPredicate(format: "label == %@", "Available models")).firstMatch
        reveal(model); XCTAssertEqual(request("/unconnected"), "ok")
        XCTAssertFalse(app.secureTextFields["API key"].exists)
        model.tap()
        let choice = app.buttons["Conversation model"]
        if choice.waitForExistence(timeout: 3) { choice.tap() }
        else {
            let picker = app.pickerWheels.firstMatch; XCTAssertTrue(picker.waitForExistence(timeout: 5), app.debugDescription)
            picker.adjust(toPickerWheelValue: "Conversation model")
            if app.buttons["Done"].exists { app.buttons["Done"].tap() }
        }
        let save = app.buttons["Save & use model"]; reveal(save)
        let review = XCTAttachment(screenshot: app.screenshot()); review.name = "model-sign-in-choice"; review.lifetime = .keepAlways; add(review)
        save.tap()
        XCTAssertTrue(app.buttons["Edit OpenRouter"].waitForExistence(timeout: 20), app.debugDescription)
        app.buttons["Back to chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my native model draft")
        composer.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        let aboveKeyboard = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            composer.frame.maxY < app.keyboards.firstMatch.frame.minY
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [aboveKeyboard], timeout: 5), .completed, app.debugDescription)
        // Native keyboard Select All avoids relying on a floating menu or an
        // inferred caret position. Check the exact value before sending.
        composer.typeKey("a", modifierFlags: .command)
        composer.typeText("I prefer short replies. Remember that.")
        XCTAssertEqual(composer.value as? String, "I prefer short replies. Remember that.")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["I saved your preference through the signed-in model."].waitForExistence(timeout: 40), app.debugDescription)
        fill(composer, "Keep my final native draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my final native draft")
        XCTAssertEqual(request("/verify"), "ok")
        let final = XCTAttachment(screenshot: app.screenshot()); final.name = "model-sign-in-native-result"; final.lifetime = .keepAlways; add(final)
    }

    func testAppBrowserSignInAndToolReview() throws {
        try checkAppSignIn(directory: false)
    }

    func testAppDirectorySignInAndToolReview() throws {
        try checkAppSignIn(directory: true)
    }

    private func checkAppSignIn(directory: Bool) throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated app sign-in fixture.")
        }
        func request(_ path: String) -> String {
            let done = expectation(description: path); var result = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 20); return result
        }
        let endpoint = request("/endpoint")
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            for _ in 0..<6 {
                if element.isHittable && element.frame.maxY < app.frame.maxY - 100 { return }
                app.swipeUp()
            }
        }
        func fill(_ field: XCUIElement, _ value: String) {
            field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
            field.typeText(value)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription)
        fill(key, "native-fixture-owner-key-24-characters"); app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["Pause companion"].tap()
        composer.tap(); composer.typeText("Keep my native chat draft")
        app.buttons["More"].tap()
        let apps = app.buttons["Connect apps"]; XCTAssertTrue(apps.waitForExistence(timeout: 15), app.debugDescription)
        reveal(apps); apps.tap()
        if directory {
            let search = app.searchFields["Search apps"]
            XCTAssertTrue(search.waitForExistence(timeout: 15), app.debugDescription)
            reveal(search); fill(search, "journal")
            let choose = app.buttons["Connect Notebook"]
            XCTAssertTrue(choose.waitForExistence(timeout: 15), app.debugDescription)
            reveal(choose)
            let listing = XCTAttachment(screenshot: app.screenshot()); listing.name = "app-directory-search"; listing.lifetime = .keepAlways; add(listing)
            choose.tap()
            XCTAssertFalse(app.textFields["App address"].exists)
        } else {
            let addApp = app.buttons["Add an app"]; XCTAssertTrue(addApp.waitForExistence(timeout: 15), app.debugDescription); reveal(addApp); addApp.tap()
            let address = app.textFields["App address"]; fill(address, endpoint)
            let checkApp = app.buttons["Continue"]; reveal(checkApp); checkApp.tap()
        }
        let signIn = app.buttons["Sign in with browser"]; XCTAssertTrue(signIn.waitForExistence(timeout: 30), app.debugDescription); reveal(signIn); signIn.tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        let allow = safari.buttons["Allow Relay"]
        XCTAssertTrue(allow.waitForExistence(timeout: 40), safari.debugDescription)
        let safariTip = safari.popovers.buttons["Close"]
        if safariTip.waitForExistence(timeout: 3) { safariTip.tap() }
        allow.tap()
        XCTAssertTrue(safari.staticTexts["You’re signed in."].waitForExistence(timeout: 20), safari.debugDescription)
        let signedIn = XCTAttachment(screenshot: safari.screenshot()); signedIn.name = "app-sign-in-safari"; signedIn.lifetime = .keepAlways; add(signedIn)
        app.activate()
        let connect = app.buttons["Connect selected tools"]
        XCTAssertTrue(connect.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(request("/unconnected"), "ok")
        let name = app.textFields["App name"]; reveal(name)
        XCTAssertEqual(name.value as? String, directory ? "Notebook" : "Local app")
        // Keep the automatic name: the shortest connection flow needs no typing here.
        let review = XCTAttachment(screenshot: app.screenshot()); review.name = "app-sign-in-tool-review"; review.lifetime = .keepAlways; add(review)
        reveal(connect); connect.tap()
        XCTAssertTrue(app.buttons[directory ? "Manage Notebook" : "Manage Local app"].waitForExistence(timeout: 15), app.debugDescription)
        app.buttons["Back to chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my native chat draft")
        XCTAssertEqual(request("/verify"), "ok")
    }

    func testAppSelectionsAndReviewedAction() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated app-selection acceptance fixture.")
        }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 20)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        let pause = app.buttons["Pause companion"]; if pause.exists { pause.tap() }
        func choose(_ name: String) {
            app.buttons["Choose an app"].tap()
            let option = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name + " app")).firstMatch
            XCTAssertTrue(option.waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Writer only app")).firstMatch.exists)
            option.tap()
            XCTAssertTrue(app.buttons["Remove " + name + " app"].waitForExistence(timeout: 10), app.debugDescription)
        }
        composer.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeText("Read and save my Sunday plan.")
        choose("Little notebook")
        XCTAssertEqual(composer.value as? String, "Read and save my Sunday plan.")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "app-mentions-native-draft"; shot.lifetime = .keepAlways; add(shot)
        app.buttons["Files"].tap(); app.buttons["Main chat"].tap()
        XCTAssertTrue(app.buttons["Remove Little notebook app"].exists)
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Read and save my Sunday plan.")
        XCTAssertTrue(app.buttons["Remove Little notebook app"].exists)
        request("/before")
        app.buttons["Send message"].tap()
        let approve = app.buttons["Approve app action"]
        XCTAssertTrue(approve.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertFalse(app.buttons["Remove Little notebook app"].exists)
        composer.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeText("Keep my next app draft")
        choose("Other notebook")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my next app draft")
        XCTAssertTrue(app.buttons["Remove Other notebook app"].exists)
        XCTAssertTrue(approve.waitForExistence(timeout: 20), app.debugDescription)
        if !approve.isHittable { app.swipeUp() }
        approve.tap()
        let final = app.staticTexts["Saved the calmer Sunday plan to Little notebook."]
        XCTAssertTrue(final.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my next app draft")
        XCTAssertTrue(app.buttons["Remove Other notebook app"].exists)
        let result = XCTAttachment(screenshot: app.screenshot()); result.name = "app-mentions-native-result"; result.lifetime = .keepAlways; add(result)
        request("/verify")
    }

    func testOfficePreviewsAndRevisions() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated Office acceptance fixture.")
        }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 20)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        let pause = app.buttons["Pause companion"]; if pause.exists { pause.tap() }
        for (kind, name) in [("document", "Weekend plan.docx"), ("spreadsheet", "Weekend budget.xlsx"), ("presentation", "Weekend briefing.pptx")] {
            request("/stage/" + kind)
            let file = app.buttons["Open " + name]
            XCTAssertTrue(file.waitForExistence(timeout: 15), app.debugDescription); file.tap()
            let preview = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Tea")).firstMatch
            XCTAssertTrue(preview.waitForExistence(timeout: 15), app.debugDescription)
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Text preview")).firstMatch.exists)
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "office-native-" + kind; shot.lifetime = .keepAlways; add(shot)
            app.buttons["Back to chat"].tap()
            composer.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
            composer.typeText("Please revise this " + kind + ": change tea to 9 and keep the other details.")
            app.buttons["Send message"].tap()
            let result = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Revised " + kind, "Version 1")).firstMatch
            XCTAssertTrue(result.waitForExistence(timeout: 30), app.debugDescription); result.tap()
            XCTAssertTrue(app.buttons["Edit result"].waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertFalse(app.buttons["Close dialog"].exists)
            app.buttons["Main chat"].tap()
            XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        }
        composer.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeText("Keep my Office draft")
        app.buttons["Files"].tap(); app.buttons["Main chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my Office draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my Office draft")
        request("/verify")
    }

    func testFocusedSettingsAndSearch() throws {
        continueAfterFailure = false
        if UIDevice.current.userInterfaceIdiom == .pad { XCUIDevice.shared.orientation = .landscapeLeft }
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        // The dedicated disposable Simulator uses only its bundled sample.
        app.launchArguments = ["-relay-server", ""]
        app.launch()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        let pause = app.buttons["Pause companion"]
        if pause.exists { pause.tap() }
        func fill(_ field: XCUIElement, _ value: String) {
            field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
            field.typeText(value)
        }
        fill(composer, "Keep this native draft")
        app.buttons["Show chats"].tap()
        let newChat = app.buttons["New side chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.buttons["Manage assistants"].exists)
        let sidebar = XCTAttachment(screenshot: app.screenshot()); sidebar.name = "simpler-native-sidebar"; sidebar.lifetime = .keepAlways; add(sidebar)
        newChat.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Message Relay…")
        composer.tap(); composer.typeText("A native side thought")
        app.buttons["Back to main chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep this native draft")
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .portrait
            XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertEqual(composer.value as? String, "Keep this native draft")
            let portrait = XCTAttachment(screenshot: app.screenshot()); portrait.name = "tablet-portrait-chat"; portrait.lifetime = .keepAlways; add(portrait)
        }
        app.buttons["Search"].tap()
        let query = app.textFields["Search your workspace"]
        XCTAssertTrue(query.waitForExistence(timeout: 10), app.debugDescription)
        fill(query, "dark mode")
        app.switches["This chat"].tap()
        let chatQuery = app.textFields["Search this chat"]
        XCTAssertTrue(chatQuery.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(chatQuery.value as? String, "dark mode")
        XCTAssertFalse(app.buttons["Appearance & personality Settings"].exists)
        let scope = XCTAttachment(screenshot: app.screenshot()); scope.name = "native-scoped-search"; scope.lifetime = .keepAlways; add(scope)
        app.switches["Chats"].tap()
        let chatsQuery = app.textFields["Search chats"]
        XCTAssertTrue(chatsQuery.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(chatsQuery.value as? String, "dark mode")
        app.switches["Everything"].tap()
        XCTAssertTrue(query.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(query.value as? String, "dark mode")
        let personal = app.buttons["Appearance & personality Settings"]
        XCTAssertTrue(personal.waitForExistence(timeout: 10), app.debugDescription)
        personal.tap()
        let name = app.textFields["Your name"]
        XCTAssertTrue(name.waitForExistence(timeout: 10), app.debugDescription)
        fill(name, "A native draft")
        app.buttons["All settings"].tap()
        XCTAssertTrue(app.buttons["Appearance & personality"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(name.exists)
        let settings = XCTAttachment(screenshot: app.screenshot()); settings.name = "simpler-native-settings"; settings.lifetime = .keepAlways; add(settings)
        app.buttons["Search"].tap()
        XCTAssertTrue(query.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        query.typeText("voice")
        app.buttons["Voice Settings"].tap()
        XCTAssertTrue(app.staticTexts["A voice for your assistant"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["All settings"].tap()
        app.buttons["Appearance & personality"].tap()
        XCTAssertEqual(name.value as? String, "A native draft")
        app.buttons["Main chat"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep this native draft")
        let chat = XCTAttachment(screenshot: app.screenshot()); chat.name = "simpler-native-chat"; chat.lifetime = .keepAlways; add(chat)
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep this native draft")
    }

    func testPrivateBrowserSignInReviewAndTakeover() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated private-browser iPhone fixture.")
        }
        func request(_ path: String) -> String {
            let done = expectation(description: path); var result = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 25); return result
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement, down: Bool = false) {
            for _ in 0..<9 {
                if element.isHittable && element.frame.minY > 185 && element.frame.maxY < app.frame.maxY - 90 { return }
                if down { app.swipeDown() } else { app.swipeUp() }
            }
        }
        func fill(_ field: XCUIElement, _ value: String) {
            XCTAssertTrue(field.waitForExistence(timeout: 30), app.debugDescription)
            reveal(field); field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
            field.typeText(value)
        }
        let key = app.secureTextFields["Server access key"]
        fill(key, "native-fixture-owner-key-24-characters"); app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        // Persist the endpoint through the shipped connection flow before testing relaunch.
        app.buttons["More"].tap()
        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10), app.debugDescription); settings.tap()
        let devices = app.buttons["Data & devices"]
        reveal(devices); devices.tap()
        app.buttons["Connect your devices"].tap()
        let connection = app.alerts["Connect your devices"]
        XCTAssertTrue(connection.waitForExistence(timeout: 10), app.debugDescription)
        connection.buttons["Connect"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["Pause companion"].tap()
        composer.tap(); composer.typeText("Keep this native browser draft")
        app.buttons["More"].tap()
        let computerPage = app.buttons["Computer"]
        XCTAssertTrue(computerPage.waitForExistence(timeout: 15), app.debugDescription)
        reveal(computerPage); computerPage.tap()
        let take = app.buttons["Take control"]
        XCTAssertTrue(take.waitForExistence(timeout: 30), app.debugDescription); take.tap()
        let give = app.buttons["Give back to Relay"]
        XCTAssertTrue(give.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(request("/owner-start"), "ok")
        fill(app.textFields["Website address"], request("/address")); app.buttons["Open website"].tap()
        fill(app.textFields["Username"], "fixture-owner")
        fill(app.secureTextFields["Password"], request("/password"))
        app.buttons["Sign in"].tap()
        XCTAssertTrue(app.textFields["Note"].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(request("/signed-in"), "ok")
        reveal(give, down: true); give.tap()
        XCTAssertTrue(take.waitForExistence(timeout: 20), app.debugDescription)
        app.buttons["Back to chat"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep this native browser draft")
        composer.tap(); composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 80) + "Save a native browser note.")
        app.buttons["Send message"].tap()
        let open = app.buttons["Open browser · review & follow along"]
        XCTAssertTrue(open.waitForExistence(timeout: 30), app.debugDescription); open.tap()
        let allow = app.buttons["Allow & continue"]
        XCTAssertTrue(allow.waitForExistence(timeout: 30), app.debugDescription)
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(open.waitForExistence(timeout: 30), app.debugDescription); open.tap()
        XCTAssertTrue(allow.waitForExistence(timeout: 30), app.debugDescription)
        var completed = false; var sawForm = false
        for _ in 0..<18 {
            let phase = request("/phase")
            if phase == "completed" { completed = true; break }
            if phase == "request" || phase == "form" {
                XCTAssertTrue(allow.waitForExistence(timeout: 20), app.debugDescription)
                if phase == "form" {
                    XCTAssertTrue(app.staticTexts["A quiet native afternoon"].waitForExistence(timeout: 10), app.debugDescription)
                    XCTAssertEqual(request("/before-form"), "ok"); sawForm = true
                }
                reveal(allow); allow.tap()
            }
            Thread.sleep(forTimeInterval: 0.7)
        }
        XCTAssertTrue(completed && sawForm, app.debugDescription)
        XCTAssertEqual(request("/saved"), "ok")
        reveal(take, down: true); take.tap()
        XCTAssertTrue(give.waitForExistence(timeout: 20), app.debugDescription)
        let data = app.descendants(matching: .any).matching(identifier: "Saved sign-ins & browser data").firstMatch
        reveal(data); data.tap()
        let clear = app.buttons["Clear browser data…"]
        reveal(clear); clear.tap()
        let keep = app.buttons["Keep data"]
        XCTAssertTrue(keep.waitForExistence(timeout: 10), app.debugDescription); reveal(keep); keep.tap()
        XCTAssertEqual(request("/retained"), "ok")
        reveal(clear); clear.tap()
        let clearPrompt = app.staticTexts["Clear all saved sign-ins and browser data?"]
        XCTAssertTrue(clearPrompt.waitForExistence(timeout: 10), app.debugDescription)
        let confirm = app.buttons.matching(NSPredicate(format: "label == %@", "Clear browser data")).firstMatch
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: confirm)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 10), .completed, app.debugDescription)
        reveal(confirm); confirm.tap()
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: clearPrompt)
        XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 15), .completed, app.debugDescription)
        XCTAssertEqual(request("/verify"), "ok")
    }

    func testPastedImageStaysInDraft() throws {
        continueAfterFailure = false
        if UIDevice.current.userInterfaceIdiom == .pad { XCUIDevice.shared.orientation = .landscapeLeft }
        defer { XCUIDevice.shared.orientation = .portrait }
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated native computer and file fixture.")
        }
        func request(_ path: String, data: Data? = nil) -> String {
            let done = expectation(description: path); var result = ""
            var request = URLRequest(url: URL(string: control + path)!)
            if let data = data { request.httpMethod = "POST"; request.httpBody = data }
            URLSession.shared.dataTask(with: request) { bytes, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = bytes.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 25); return result
        }
        let image = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 32)).image { context in
            UIColor.systemGreen.setFill(); context.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
        }
        let png = try XCTUnwrap(image.pngData())
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.terminate()
        XCTAssertEqual(request("/prepare-paste"), "ok")
        XCTAssertEqual(request("/paste-fixture", data: png), "ok")
        app.launchArguments = ["-relay-server", server, "--relay-paste-ui-test"]
        app.launchEnvironment["RELAY_PASTE_TEST_IMAGE"] = png.base64EncodedString()
        app.launch()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Message Relay…")
        // A foreground debug source creates a real OS clipboard item. WebKit's
        // actual Paste action and production upload path handle the destination.
        app.buttons["Copy test image"].tap()
        composer.tap(); composer.typeText("Keep my pasted image draft")
        composer.press(forDuration: 1.2)
        let paste = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Paste")).firstMatch
        if !paste.waitForExistence(timeout: 3) { composer.tap() }
        XCTAssertTrue(paste.waitForExistence(timeout: 10), app.debugDescription); paste.tap()
        let allow = app.buttons["Allow Paste"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        let remove = app.buttons["Remove attachment"]
        XCTAssertTrue(remove.waitForExistence(timeout: 20), app.debugDescription)
        let photo = app.buttons["Open image.png"]
        XCTAssertTrue(photo.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertGreaterThan(photo.frame.height, 90)
        XCTAssertEqual(request("/photo-draft"), "ok")
        photo.tap()
        XCTAssertTrue(app.buttons["Save file"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.images["image.png"].exists, app.debugDescription)
        app.buttons["Back to chat"].tap()
        XCTAssertEqual(composer.value as? String, "Keep my pasted image draft")
        XCTAssertEqual(request("/pasted"), "ok")
        if UIDevice.current.userInterfaceIdiom == .pad { XCUIDevice.shared.orientation = .portrait }
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(remove.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my pasted image draft")
        XCTAssertEqual(request("/paste-reopened"), "ok")
    }

    func testComputerClipboardRoundTrip() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"],
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"] else {
            throw XCTSkip("Run the isolated computer clipboard fixture.")
        }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement, down: Bool = false) {
            for _ in 0..<10 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY - 10 : app.frame.maxY - 92
                if element.isHittable && element.frame.minY > 150 && element.frame.maxY < bottom { return }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: down ? 0.35 : 0.72))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: down ? 0.75 : 0.32)))
            }
        }
        func type(_ element: XCUIElement, _ text: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription); reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(text)
        }
        type(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        type(composer, "Keep this draft: ")
        app.buttons["More"].tap()
        let computer = app.buttons["Computer"]; XCTAssertTrue(computer.waitForExistence(timeout: 10)); reveal(computer); computer.tap()
        let take = app.buttons["Take control"]; XCTAssertTrue(take.waitForExistence(timeout: 30), app.debugDescription); reveal(take); take.tap()
        XCTAssertTrue(app.buttons["Give back to Relay"].waitForExistence(timeout: 20), app.debugDescription)
        request("/prepare-copy")
        let copy = app.buttons["Copy text from computer"]; XCTAssertTrue(copy.waitForExistence(timeout: 20), app.debugDescription); reveal(copy); copy.tap()
        XCTAssertTrue(app.staticTexts["Copied to your device."].waitForExistence(timeout: 20), app.debugDescription)
        let copied = XCTAttachment(screenshot: app.screenshot()); copied.name = "computer-clipboard-native-copy"; copied.lifetime = .keepAlways; add(copied)
        let back = app.buttons["Back to chat"]; reveal(back, down: true); back.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep this draft: ")
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        let aboveKeyboard = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            composer.frame.maxY < app.keyboards.firstMatch.frame.minY
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [aboveKeyboard], timeout: 5), .completed, app.debugDescription)
        composer.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        composer.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).press(forDuration: 1.2)
        let paste = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Paste")).firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 10), app.debugDescription); paste.tap()
        let allow = app.buttons["Allow Paste"]; if allow.waitForExistence(timeout: 2) { allow.tap() }
        let pasted = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Keep this draft: Hello 你好 café 🌱"), object: composer)
        XCTAssertEqual(XCTWaiter.wait(for: [pasted], timeout: 15), .completed, app.debugDescription)
        request("/verify-copy")
    }

    func testDirectComputerInputAndRelaunch() throws {
        continueAfterFailure = false
        if UIDevice.current.userInterfaceIdiom == .pad { XCUIDevice.shared.orientation = .landscapeLeft }
        defer { XCUIDevice.shared.orientation = .portrait }
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated real-computer iPhone fixture.")
        }
        func request(_ path: String) -> String {
            let done = expectation(description: path); var result = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 25); return result
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement, down: Bool = false) {
            for _ in 0..<10 {
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY - 10 : app.frame.maxY - 92
                if element.isHittable && element.frame.minY > 150 && element.frame.maxY < bottom { return }
                // Scroll the page's outer gutter, not the interactive guest screen.
                let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: down ? 0.35 : 0.72))
                let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: down ? 0.75 : 0.32))
                start.press(forDuration: 0.05, thenDragTo: end)
            }
        }
        func fill(_ element: XCUIElement, _ value: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            reveal(element); element.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { element.tap() }
            element.typeText(value)
        }
        func openComputer() {
            app.buttons["More"].tap()
            let entry = app.buttons["Computer"]
            XCTAssertTrue(entry.waitForExistence(timeout: 15), app.debugDescription)
            reveal(entry); entry.tap()
        }
        let composer = app.textViews["Message Relay"]
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters")
        app.buttons["Open workspace"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["More"].tap()
        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10), app.debugDescription)
        reveal(settings); settings.tap()
        let devices = app.buttons["Data & devices"]; reveal(devices); devices.tap()
        app.buttons["Connect your devices"].tap()
        let connection = app.alerts["Connect your devices"]
        XCTAssertTrue(connection.waitForExistence(timeout: 10), app.debugDescription); connection.buttons["Connect"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my iPhone computer draft")
        openComputer()
        let take = app.buttons["Take control"]
        XCTAssertTrue(take.waitForExistence(timeout: 30), app.debugDescription); reveal(take); take.tap()
        let give = app.buttons["Give back to Relay"]
        XCTAssertTrue(give.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(request("/owner"), "ok")
        let screen = app.buttons["Control private desktop"]
        XCTAssertTrue(screen.waitForExistence(timeout: 20), app.debugDescription)
        // Focus the actual guest editor with a native tap on its displayed pixels.
        let state = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(request("/window").utf8)) as? [String:Any])
        let x = try XCTUnwrap(state["x"] as? Double), y = try XCTUnwrap(state["y"] as? Double)
        reveal(screen)
        screen.coordinate(withNormalizedOffset: CGVector(dx: (x + 35) / 1280, dy: (y + 25) / 800)).tap()
        let keyboardButton = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Show computer keyboard")).firstMatch
        XCTAssertTrue(keyboardButton.waitForExistence(timeout: 10), app.debugDescription); reveal(keyboardButton); keyboardButton.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        let direct = app.textViews["Type directly on the computer"]
        XCTAssertTrue(direct.waitForExistence(timeout: 10), app.debugDescription)
        direct.typeText("hello from my iPhone.x")
        direct.typeText(XCUIKeyboardKey.delete.rawValue)
        direct.typeText("\nSecond line")
        XCTAssertEqual(request("/typed"), "ok")
        let keyboardShot = XCTAttachment(screenshot: app.screenshot()); keyboardShot.name = "computer-live-keyboard"; keyboardShot.lifetime = .keepAlways; add(keyboardShot)
        let done = app.buttons["Done"]
        reveal(done); done.tap()
        let hiddenKeyboard = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [hiddenKeyboard], timeout: 10), .completed, app.debugDescription)
        reveal(screen, down: true)
        let dragMode = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Drag on the computer")).firstMatch
        XCTAssertTrue(dragMode.waitForExistence(timeout: 10)); reveal(dragMode); dragMode.tap()
        reveal(screen, down: true)
        XCTAssertEqual(request("/before-drag"), "ok")
        screen.coordinate(withNormalizedOffset: CGVector(dx: (x + 220) / 1280, dy: (y - 10) / 800))
            .press(forDuration: 0.15, thenDragTo: screen.coordinate(withNormalizedOffset: CGVector(dx: (x + 360) / 1280, dy: (y + 65) / 800)))
        XCTAssertEqual(request("/after-drag"), "ok")
        let zoom = app.buttons["Zoom in"]; reveal(zoom); zoom.tap()
        let fit = app.buttons["Fit screen"]
        XCTAssertTrue(fit.waitForExistence(timeout: 10), app.debugDescription); XCTAssertEqual(request("/zoomed"), "ok")
        reveal(fit); fit.tap()
        let back = app.buttons["Back to chat"]; reveal(back, down: true); back.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone computer draft")
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone computer draft")
        openComputer()
        XCTAssertTrue(give.waitForExistence(timeout: 20), app.debugDescription)
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .portrait
            XCTAssertTrue(give.waitForExistence(timeout: 10), app.debugDescription)
        }
        XCTAssertEqual(request("/reopened"), "ok")
        reveal(back, down: true); back.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone computer draft")
        XCTAssertTrue(give.waitForExistence(timeout: 10), app.debugDescription); give.tap()
        let handedBack = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: give)
        XCTAssertEqual(XCTWaiter.wait(for: [handedBack], timeout: 20), .completed, app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my iPhone computer draft")
        XCTAssertEqual(request("/verify"), "ok")
    }

    func testChatModelSetupReturn() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated chat-setup fixture.")
        }
        func request(_ path: String) -> String {
            let done = expectation(description: path); var result = ""
            URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 30); return result
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 30), app.debugDescription)
            for _ in 0..<12 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 130
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY)))
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func tap(_ label: String) { let button = app.buttons[label]; reveal(button); button.tap() }
        func fill(_ field: XCUIElement, _ value: String) {
            field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(value)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription)
        fill(key, "native-fixture-owner-key-24-characters"); app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        let start = XCTAttachment(screenshot: app.screenshot()); start.name = "chat-setup-native-start"; start.lifetime = .keepAlways; add(start)
        tap("Connect AI"); XCTAssertEqual(request("/before"), "ok")
        app.buttons["Back to chat"].tap()
        fill(composer, "Keep my first native message")
        tap("Connect AI"); tap("Use a local model")
        XCTAssertEqual(request("/unconnected"), "ok")
        tap("Use this model")
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertFalse(app.buttons["Back to chat"].exists, "Activation should return directly to chat")
        XCTAssertEqual(composer.value as? String, "Keep my first native message")
        XCTAssertEqual(request("/connected"), "ok")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["Your local model is connected. We can keep talking here."].waitForExistence(timeout: 30), app.debugDescription)
        fill(composer, "Keep my final native draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my final native draft")
        XCTAssertEqual(request("/verify"), "ok")
        let final = XCTAttachment(screenshot: app.screenshot()); final.name = "chat-setup-native-reply"; final.lifetime = .keepAlways; add(final)
    }


    func testLocalModelInstallation() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated local-install fixture.")
        }
        func request(_ path: String) -> String {
            let done = expectation(description: path); var result = ""
            var urlRequest = URLRequest(url: URL(string: control + path)!); urlRequest.timeoutInterval = 180
            URLSession.shared.dataTask(with: urlRequest) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 190); return result
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 90), app.debugDescription)
            for _ in 0..<12 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 130
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY)))
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func tap(_ label: String) { let button = app.buttons[label]; reveal(button); button.tap() }
        func fill(_ field: XCUIElement, _ value: String) {
            field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(value)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription)
        fill(key, "native-fixture-owner-key-24-characters"); app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Say hello in one short sentence.")
        tap("Connect AI"); XCTAssertEqual(request("/before"), "ok")
        tap("Use a local model")
        let start = XCTAttachment(screenshot: app.screenshot()); start.name = "local-install-native-start"; start.lifetime = .keepAlways; add(start)
        tap("Install Ollama · 167 MB")
        XCTAssertTrue(app.buttons["Cancel installation"].waitForExistence(timeout: 30), app.debugDescription)
        app.terminate(); app.launch()
        tap("Connect AI"); tap("Use a local model")
        tap("Cancel installation")
        XCTAssertTrue(app.staticTexts["Installation cancelled."].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(request("/cancelled"), "ok")
        tap("Retry installation")
        XCTAssertTrue(app.buttons["Start Ollama"].waitForExistence(timeout: 90), app.debugDescription)
        XCTAssertEqual(request("/installed"), "ok")
        tap("Start Ollama")
        tap("Use this model")
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Say hello in one short sentence.")
        XCTAssertEqual(request("/connected"), "ok")
        app.buttons["Send message"].tap()
        let answer = request("/answer")
        XCTAssertFalse(answer.isEmpty)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", String(answer.prefix(45)))).firstMatch.waitForExistence(timeout: 15), app.debugDescription)
        fill(composer, "Keep my installed native draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my installed native draft")
        XCTAssertEqual(request("/verify"), "ok")
        let final = XCTAttachment(screenshot: app.screenshot()); final.name = "local-install-native-reply"; final.lifetime = .keepAlways; add(final)
    }


    func testLocalModelQuickSetup() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated local-install fixture.")
        }
        func request(_ path: String) -> String {
            let done = expectation(description: path); var result = ""
            var urlRequest = URLRequest(url: URL(string: control + path)!); urlRequest.timeoutInterval = 180
            URLSession.shared.dataTask(with: urlRequest) { data, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                result = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.fulfill()
            }.resume(); wait(for: [done], timeout: 190); return result
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 90), app.debugDescription)
            for _ in 0..<12 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 130
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY)))
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func tap(_ label: String) { let button = app.buttons[label]; reveal(button); button.tap() }
        func fill(_ field: XCUIElement, _ value: String) {
            field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(value)
        }
        let key = app.secureTextFields["Server access key"]
        XCTAssertTrue(key.waitForExistence(timeout: 30), app.debugDescription)
        fill(key, "native-fixture-owner-key-24-characters"); app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 120), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Say hello in one short sentence.")
        tap("Connect AI"); XCTAssertEqual(request("/before"), "ok")
        tap("Use a local model")
        let start = XCTAttachment(screenshot: app.screenshot()); start.name = "local-quick-native-start"; start.lifetime = .keepAlways; add(start)
        tap("Set up & use")
        XCTAssertTrue(app.buttons["Cancel setup"].waitForExistence(timeout: 30), app.debugDescription)
        app.terminate(); app.launch()
        tap("Connect AI"); tap("Use a local model")
        tap("Cancel setup")
        XCTAssertTrue(app.staticTexts["Setup cancelled. Your AI connection is unchanged. Downloaded files are kept."].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(request("/cancelled"), "ok")
        tap("Continue setup")
        XCTAssertTrue(composer.waitForExistence(timeout: 120), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Say hello in one short sentence.")
        XCTAssertEqual(request("/connected"), "ok")
        app.buttons["Send message"].tap()
        let answer = request("/answer")
        XCTAssertFalse(answer.isEmpty)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", String(answer.prefix(45)))).firstMatch.waitForExistence(timeout: 15), app.debugDescription)
        fill(composer, "Keep my installed native draft")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 120), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my installed native draft")
        XCTAssertEqual(request("/verify"), "ok")
        let final = XCTAttachment(screenshot: app.screenshot()); final.name = "local-quick-native-reply"; final.lifetime = .keepAlways; add(final)
    }


    func testPrivateComputerInstallation() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated private-computer installation fixture.")
        }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 45), app.debugDescription)
            for _ in 0..<16 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 130
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY)))
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func tap(_ label: String) {
            let element = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
            reveal(element); element.tap()
        }
        func fill(_ field: XCUIElement, _ value: String) {
            reveal(field); field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(value)
        }
        func openComputer() { app.buttons["More"].tap(); tap("Computer") }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my native computer draft"); openComputer(); request("/before")
        tap("Set up computer")
        XCTAssertTrue(app.buttons["Cancel setup"].waitForExistence(timeout: 30), app.debugDescription)
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native computer draft")
        openComputer(); tap("Cancel setup")
        XCTAssertTrue(app.staticTexts["Setup cancelled. Continue whenever you’re ready."].waitForExistence(timeout: 30), app.debugDescription)
        request("/cancelled"); tap("Continue setup")
        XCTAssertTrue(app.buttons["Take control"].waitForExistence(timeout: 1500), app.debugDescription)
        request("/ready"); tap("Take control"); tap("Commands & activity")
        fill(app.textViews["Private computer command"], "printf 'Native private computer works' > native-install.txt")
        tap("Run command")
        let run = app.buttons["Run command"]
        let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in run.isEnabled }, object: run)
        XCTAssertEqual(XCTWaiter.wait(for: [completed], timeout: 45), .completed, app.debugDescription)
        if app.keyboards.buttons["Done"].exists { app.keyboards.buttons["Done"].tap() }
        request("/verify")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "computer-install-native-ready"; shot.lifetime = .keepAlways; add(shot)
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native computer draft")
        openComputer(); XCTAssertTrue(app.buttons["Give back to Relay"].waitForExistence(timeout: 30), app.debugDescription)
        request("/verify")
    }

    func testPrivateComputerSleep() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_SERVER"], server.hasPrefix("https://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_CONNECTION_TEST_CONTROL"], control.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("Run the isolated private-computer sleep fixture.")
        }
        func request(_ path: String) {
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: URL(string: control + path)!) { _, response, error in
                XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
            }.resume(); wait(for: [done], timeout: 30)
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]; app.launch()
        func reveal(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 45), app.debugDescription)
            for _ in 0..<16 {
                let dock = app.buttons["More"], back = app.buttons["Back to chat"]
                var bottom = dock.exists && dock.frame.minY > 0 ? dock.frame.minY - 12 : app.frame.maxY - 100
                if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
                let top = back.exists ? back.frame.maxY + 12 : app.frame.minY + 130
                if element.isHittable && element.frame.minY >= top && element.frame.maxY <= bottom { return }
                let x = app.frame.maxX - 18
                let startY = element.frame.minY < top ? top + 25 : bottom - 25
                let endY = element.frame.minY < top ? bottom - 25 : top + 25
                app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: startY)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: endY)))
            }
            XCTAssertTrue(element.isHittable, app.debugDescription)
        }
        func tap(_ label: String) {
            let element = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
            reveal(element); element.tap()
        }
        func fill(_ field: XCUIElement, _ value: String) {
            reveal(field); field.tap(); if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }; field.typeText(value)
        }
        func openComputer() { app.buttons["More"].tap(); tap("Computer") }
        fill(app.secureTextFields["Server access key"], "native-fixture-owner-key-24-characters"); app.buttons["Open workspace"].tap()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        if app.buttons["Pause companion"].exists { app.buttons["Pause companion"].tap() }
        fill(composer, "Keep my native sleep draft"); openComputer()
        XCTAssertTrue(app.buttons["Take control"].waitForExistence(timeout: 45), app.debugDescription)
        tap("Take control"); tap("Commands & activity")
        fill(app.textViews["Private computer command"], "printf 'Native private computer sleep works' > native-sleep.txt")
        tap("Run command")
        let run = app.buttons["Run command"]
        let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in run.isEnabled }, object: run)
        XCTAssertEqual(XCTWaiter.wait(for: [completed], timeout: 45), .completed, app.debugDescription)
        if app.keyboards.buttons["Done"].exists { app.keyboards.buttons["Done"].tap() }
        request("/before")
        tap("Stop computer and keep files")
        XCTAssertTrue(app.buttons["Start computer"].waitForExistence(timeout: 120), app.debugDescription)
        request("/asleep")
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native sleep draft")
        openComputer(); XCTAssertTrue(app.buttons["Start computer"].waitForExistence(timeout: 30), app.debugDescription)
        request("/asleep"); tap("Start computer")
        XCTAssertTrue(app.buttons["Give back to Relay"].waitForExistence(timeout: 240), app.debugDescription)
        request("/awake")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "computer-sleep-native-awake"; shot.lifetime = .keepAlways; add(shot)
        tap("Back to chat"); XCTAssertEqual(composer.value as? String, "Keep my native sleep draft")
    }

}
