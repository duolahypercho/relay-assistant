import XCTest

final class NotificationsUITests: XCTestCase {
    func testNativePushTapReturnsToSideChatAndKeepsMainDraft() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["RELAY_NOTIFICATION_TEST_SERVER"], server.hasPrefix("http://127.0.0.1:"),
              let control = ProcessInfo.processInfo.environment["RELAY_NOTIFICATION_TEST_CONTROL"], let trigger = URL(string: control + "/ready") else {
            throw XCTSkip("Run NotificationsAcceptance against its isolated local fixture.")
        }
        let app = XCUIApplication(bundleIdentifier: "org.relay.assistant")
        app.launchArguments = ["-relay-server", server]
        app.launch()
        let composer = app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        composer.tap(); composer.typeText("Keep my native notification draft")
        app.buttons["More"].tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["Settings"].tap()
        let dataSettings = app.buttons["Data & devices"]
        for _ in 0..<6 {
            if dataSettings.isHittable && dataSettings.frame.maxY < app.frame.maxY - 100 { break }
            app.swipeUp()
        }
        dataSettings.tap()
        // Persist the server through the real connection dialog. Launch arguments
        // alone disappear when iOS launches the app from a notification.
        app.buttons["Connect your devices"].tap()
        let connection = app.alerts["Connect your devices"]
        XCTAssertTrue(connection.waitForExistence(timeout: 10), app.debugDescription)
        connection.buttons["Connect"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["More"].tap()
        app.buttons["Settings"].tap()
        let notifications = app.buttons.matching(identifier: "Notifications")
        notifications.element(boundBy: notifications.count - 1).tap()
        let toggle = app.switches["Notify this device"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 15), app.debugDescription)
        app.swipeUp()
        toggle.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }
        // Remote registration may be unavailable on an unsigned Simulator. The OS
        // permission and delivery/tap path use real UserNotifications + simctl push.
        app.buttons["Main chat"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native notification draft")
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
        let pushed = expectation(description: "Simulator push accepted")
        URLSession.shared.dataTask(with: trigger) { _, response, error in
            XCTAssertNil(error)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            pushed.fulfill()
        }.resume()
        wait(for: [pushed], timeout: 20)
        let banner = springboard.staticTexts["Your Sunday plan is ready."]
        XCTAssertTrue(banner.waitForExistence(timeout: 15), springboard.debugDescription)
        let notification = XCTAttachment(screenshot: springboard.screenshot())
        notification.name = "native-push-banner"; notification.lifetime = .keepAlways; add(notification)
        banner.tap()
        XCTAssertTrue(app.staticTexts["Our weekend"].firstMatch.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Your Sunday plan is ready."].firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        let destination = XCTAttachment(screenshot: app.screenshot())
        destination.name = "native-push-destination"; destination.lifetime = .keepAlways; add(destination)
        app.buttons["Back to main chat"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native notification draft")
        app.terminate()
        let coldPush = expectation(description: "Push for terminated app")
        URLSession.shared.dataTask(with: trigger) { _, response, error in
            XCTAssertNil(error)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            coldPush.fulfill()
        }.resume()
        wait(for: [coldPush], timeout: 20)
        XCTAssertTrue(banner.waitForExistence(timeout: 15), springboard.debugDescription)
        banner.tap()
        XCTAssertTrue(app.staticTexts["Our weekend"].firstMatch.waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["Back to main chat"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Keep my native notification draft")
    }
}
