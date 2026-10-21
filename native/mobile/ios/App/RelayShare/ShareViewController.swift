import UIKit

// A small native conversation picker. Attach saves to the app-group inbox; it never sends to a model.
final class ShareViewController:UIViewController,UITableViewDataSource,UITableViewDelegate {
    private let table=UITableView(frame:.zero,style:.insetGrouped)
    private let summary=UILabel(),notice=UILabel()
    private var context:RelayShareContext?,item:RelayShareItem?,selected:String?
    private var attachButton:UIBarButtonItem!
    override func viewDidLoad() {
        super.viewDidLoad();view.backgroundColor = .systemBackground
        let nav=UINavigationBar();nav.translatesAutoresizingMaskIntoConstraints=false
        let title=UINavigationItem(title:"Share to Relay")
        title.leftBarButtonItem=UIBarButtonItem(title:"Cancel",style:.plain,target:self,action:#selector(cancel))
        attachButton=UIBarButtonItem(title:"Attach",style:.done,target:self,action:#selector(attach));attachButton.isEnabled=false;title.rightBarButtonItem=attachButton;nav.items=[title]
        summary.text="Preparing your share…";summary.numberOfLines=3;summary.font = .preferredFont(forTextStyle:.body)
        notice.text="Your draft stays. Open Relay when you’re ready to send.";notice.numberOfLines=0;notice.font = .preferredFont(forTextStyle:.footnote);notice.textColor = .secondaryLabel
        table.dataSource=self;table.delegate=self
        let stack=UIStackView(arrangedSubviews:[summary,table,notice]);stack.axis = .vertical;stack.spacing=16;stack.translatesAutoresizingMaskIntoConstraints=false
        view.addSubview(nav);view.addSubview(stack)
        NSLayoutConstraint.activate([nav.topAnchor.constraint(equalTo:view.safeAreaLayoutGuide.topAnchor),nav.leadingAnchor.constraint(equalTo:view.leadingAnchor),nav.trailingAnchor.constraint(equalTo:view.trailingAnchor),stack.topAnchor.constraint(equalTo:nav.bottomAnchor,constant:16),stack.leadingAnchor.constraint(equalTo:view.leadingAnchor,constant:16),stack.trailingAnchor.constraint(equalTo:view.trailingAnchor,constant:-16),stack.bottomAnchor.constraint(equalTo:view.safeAreaLayoutGuide.bottomAnchor,constant:-16),table.heightAnchor.constraint(greaterThanOrEqualToConstant:120)])
        Task { @MainActor in
            do {
                let saved=try RelayShareStore().context();guard !saved.chats.isEmpty else {throw RelayShareStore.error("Open Relay and choose your server before sharing.")}
                context=saved;selected=saved.chats.first(where:{$0.id=="main"})?.id ?? saved.chats.first?.id;table.reloadData()
                let providers=(extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap{$0.attachments ?? []}
                item=try await RelayShareLoader.load(providers,scope:saved.scope)
                summary.text=([item?.text ?? ""]+(item?.files.map(\.name) ?? [])).filter{!$0.isEmpty}.joined(separator:"\n")
                notice.text="\(saved.label) · Attached items wait in your composer. Open Relay to add a message and send."
                attachButton.isEnabled=true
            } catch {summary.text="Could not prepare this share";notice.text=error.localizedDescription}
        }
    }
    func tableView(_ tableView:UITableView,numberOfRowsInSection section:Int)->Int {context?.chats.count ?? 0}
    func tableView(_ tableView:UITableView,cellForRowAt indexPath:IndexPath)->UITableViewCell {
        let cell=UITableViewCell(style:.default,reuseIdentifier:nil),chat=context!.chats[indexPath.row]
        cell.textLabel?.text=chat.title;cell.accessoryType=chat.id==selected ? .checkmark:.none;cell.accessibilityIdentifier="Share to \(chat.id)";return cell
    }
    func tableView(_ tableView:UITableView,didSelectRowAt indexPath:IndexPath){selected=context?.chats[indexPath.row].id;table.reloadData()}
    @objc private func cancel(){extensionContext?.cancelRequest(withError:NSError(domain:NSCocoaErrorDomain,code:NSUserCancelledError))}
    @objc private func attach(){
        do {guard var value=item,let selected=selected else{return};let store=try RelayShareStore();let current=try store.context();guard current.scope==value.scope,current.chats.contains(where:{$0.id==selected}) else{throw RelayShareStore.error("Your workspace changed. Cancel and share again.")};value.threadId=selected;try store.enqueue(value);attachButton.isEnabled=false;extensionContext?.completeRequest(returningItems:nil)} catch {notice.text=error.localizedDescription}
    }
}
