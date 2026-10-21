// SPDX-License-Identifier: MIT
// Observable local text editor used only by real-computer acceptance.
export const computerInputFixture = `import tkinter as tk, json, os
r=tk.Tk(); r.title('Relay input acceptance'); r.geometry('700x380+100+180'); r.attributes('-topmost',True)
t=tk.Text(r,font=('DejaVu Sans',18),wrap='word'); t.pack(fill='both',expand=True); t.focus_set()
def select_all(e):
 t.tag_add('sel','1.0','end-1c'); return 'break'
t.bind('<Control-a>',select_all)
# Tk/X11 normally inserts paste beside a selection; model a conventional editor.
def paste(e):
 value=t.clipboard_get()
 try: t.delete('sel.first','sel.last')
 except tk.TclError: pass
 t.insert('insert',value); return 'break'
t.bind('<<Paste>>',paste)
pressed=False
def button(e):
 global pressed
 pressed=e.type==tk.EventType.ButtonPress
r.bind_all('<ButtonPress-1>',button,add='+'); r.bind_all('<ButtonRelease-1>',button,add='+')
def save():
 try: selection=t.get('sel.first','sel.last')
 except tk.TclError: selection=''
 boxes={}
 for index in ['1.0','1.5','1.10']:
  box=t.bbox(index)
  if box: boxes[index]=[t.winfo_rootx()+box[0],t.winfo_rooty()+box[1],box[2],box[3]]
 data={'text':t.get('1.0','end-1c'),'selection':selection,'x':r.winfo_rootx(),'y':r.winfo_rooty(),'pressed':pressed,'boxes':boxes,'view':t.yview()}
 with open('/workspace/input-state.next','w') as f: json.dump(data,f)
 os.replace('/workspace/input-state.next','/workspace/input-state.json');r.after(60,save)
r.after(60,save);r.mainloop()
`;
