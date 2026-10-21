#if DEBUG
import UIKit
// A deterministic source app surface for the system Share sheet acceptance test.
// It is compiled out of release builds and appears only with the explicit test argument.
extension RelayBridgeViewController {
    func installShareTestSource() {
        if ProcessInfo.processInfo.arguments.contains("--relay-paste-ui-test") {
            let button = UIButton(type: .system)
            button.setTitle("Copy test image", for: .normal)
            button.accessibilityIdentifier = "Copy test image"
            button.backgroundColor = .systemBackground
            button.translatesAutoresizingMaskIntoConstraints = false
            button.addTarget(self, action: #selector(copyPasteTestImage(_:)), for: .touchUpInside)
            view.addSubview(button)
            NSLayoutConstraint.activate([button.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 100), button.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16), button.widthAnchor.constraint(equalToConstant: 150), button.heightAnchor.constraint(equalToConstant: 44)])
        }
        guard ProcessInfo.processInfo.arguments.contains("--relay-share-ui-test") else{return}
        let button=UIButton(type:.system);button.setTitle("Share test items",for:.normal);button.accessibilityIdentifier="Share test items";button.backgroundColor = .systemBackground;button.layer.cornerRadius=12;button.translatesAutoresizingMaskIntoConstraints=false
        button.addTarget(self,action:#selector(openShareTestSource),for:.touchUpInside);view.addSubview(button)
        NSLayoutConstraint.activate([button.topAnchor.constraint(equalTo:view.safeAreaLayoutGuide.topAnchor,constant:95),button.trailingAnchor.constraint(equalTo:view.trailingAnchor,constant:-16),button.widthAnchor.constraint(equalToConstant:150),button.heightAnchor.constraint(equalToConstant:40)])
    }
    @objc func copyPasteTestImage(_ sender: UIButton) {
        // Only this explicit debug fixture writes the disposable Simulator clipboard.
        guard let value = ProcessInfo.processInfo.environment["RELAY_PASTE_TEST_IMAGE"],
              let png = Data(base64Encoded: value) else { return }
        UIPasteboard.general.setData(png, forPasteboardType: "public.png")
        sender.removeFromSuperview()
    }
    @objc func openShareTestSource(){
        do {
            _ = try RelayShareStore().context()
            let url=FileManager.default.temporaryDirectory.appendingPathComponent("native-share.txt");try Data("Actual iOS shared file bytes.".utf8).write(to:url)
            let image=UIGraphicsImageRenderer(size:CGSize(width:24,height:24)).image { context in UIColor.systemGreen.setFill();context.fill(CGRect(x:0,y:0,width:24,height:24)) }
            let controller=UIActivityViewController(activityItems:["A real iOS shared note",URL(string:"https://example.invalid/native-share")!,url,image],applicationActivities:nil)
            controller.popoverPresentationController?.sourceView=view
            present(controller,animated:true)
        }catch {let alert=UIAlertController(title:"Share test",message:error.localizedDescription,preferredStyle:.alert);alert.addAction(UIAlertAction(title:"OK",style:.default));present(alert,animated:true)}
    }
}
#endif
