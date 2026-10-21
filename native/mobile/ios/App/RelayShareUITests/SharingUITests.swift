import XCTest

final class SharingUITests:XCTestCase {
    func testSystemShareSheetToExtensionToSavedComposer() throws {
        continueAfterFailure=false
        let app=XCUIApplication(bundleIdentifier:"org.relay.assistant")
        guard let server=ProcessInfo.processInfo.environment["RELAY_SHARE_TEST_SERVER"],server.hasPrefix("http://127.0.0.1:") else { return XCTFail("Pass the isolated fixture server through the ShareAcceptance scheme.") }
        print("Native sharing fixture",server)
        app.launchArguments=["-relay-server",server,"--relay-share-ui-test"]
        app.launch()
        let composer=app.textViews["Message Relay"]
        XCTAssertTrue(composer.waitForExistence(timeout:30),app.debugDescription)
        composer.tap();composer.typeText("Keep my native draft")
        app.buttons["Share test items"].tap()
        let share=app.cells.matching(NSPredicate(format:"label == %@", "Relay")).firstMatch
        if !share.waitForExistence(timeout:8) {
            let more=app.cells.matching(NSPredicate(format:"label == %@", "More")).firstMatch
            if more.exists {more.tap()}
        }
        XCTAssertTrue(share.waitForExistence(timeout:10),app.debugDescription);share.tap()
        let attach=app.buttons["Attach"]
        XCTAssertTrue(attach.waitForExistence(timeout:20),app.debugDescription)
        XCTAssertTrue(app.cells["Share to main"].waitForExistence(timeout:10),app.debugDescription)
        let ready=NSPredicate(format:"enabled == true")
        let loaded=expectation(for:ready,evaluatedWith:attach)
        XCTAssertEqual(XCTWaiter.wait(for:[loaded],timeout:25),.completed,app.debugDescription)
        let picker=XCTAttachment(screenshot:app.screenshot());picker.name="native-share-picker";picker.lifetime = .keepAlways;add(picker)
        attach.tap()
        XCTAssertTrue(app.staticTexts["native-share.txt"].firstMatch.waitForExistence(timeout:30),app.debugDescription)
        XCTAssertEqual(composer.value as? String,"Keep my native draft")
        app.terminate();app.launch()
        XCTAssertTrue(app.staticTexts["native-share.txt"].firstMatch.waitForExistence(timeout:30),app.debugDescription)
        XCTAssertEqual(app.textViews["Message Relay"].value as? String,"Keep my native draft")
        let draft=XCTAttachment(screenshot:app.screenshot());draft.name="native-share-composer";draft.lifetime = .keepAlways;add(draft)
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["Your native share arrived."].waitForExistence(timeout:30),app.debugDescription)
    }
}
