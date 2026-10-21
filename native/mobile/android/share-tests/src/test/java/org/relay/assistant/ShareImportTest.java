package org.relay.assistant;

import static org.junit.Assert.*;
import android.content.*;
import android.content.pm.ProviderInfo;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.*;
import android.provider.OpenableColumns;
import android.util.Base64;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowContentResolver;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE, sdk=35)
public class ShareImportTest {
    Context context;
    SourceProvider provider;
    ShareInbox inbox;
    final String server = "https://relay.example.test";
    final String scope = "[\"https://relay.example.test\",\"2026-10-11\"]";
    static final byte[] PNG = Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIuoAAAAASUVORK5CYII=", Base64.DEFAULT);

    public static class SourceProvider extends ContentProvider {
        Map<String,byte[]> data = new HashMap<>();
        Map<String,String> names = new HashMap<>(), types = new HashMap<>();
        Map<String,Long> sizes = new HashMap<>();
        Set<String> denied = new HashSet<>();
        int opened;
        Runnable onOpen;
        Uri add(String name, String type, byte[] bytes) {
            String key=UUID.randomUUID().toString(); data.put(key,bytes); names.put(key,name); types.put(key,type);
            return Uri.parse("content://relay-share-test/"+key);
        }
        @Override public boolean onCreate(){ return true; }
        @Override public String getType(Uri uri){ return types.get(uri.getLastPathSegment()); }
        @Override public Cursor query(Uri uri,String[] columns,String selection,String[] args,String sort) {
            String key=uri.getLastPathSegment(); MatrixCursor cursor=new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE});
            cursor.addRow(new Object[]{names.get(key),sizes.getOrDefault(key,(long)data.get(key).length)}); return cursor;
        }
        @Override public AssetFileDescriptor openAssetFile(Uri uri,String mode) throws FileNotFoundException {
            String key=uri.getLastPathSegment();
            if (denied.contains(key)) throw new SecurityException("Source grant revoked");
            opened++;
            if(onOpen!=null)onOpen.run();
            try {
                File file=new File(getContext().getCacheDir(),key); Files.write(file.toPath(),data.get(key));
                return new AssetFileDescriptor(ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_ONLY),0,data.get(key).length);
            } catch(IOException error) { throw new FileNotFoundException(error.getMessage()); }
        }
        @Override public Uri insert(Uri uri,ContentValues values){ throw new UnsupportedOperationException(); }
        @Override public int delete(Uri uri,String selection,String[] args){ throw new UnsupportedOperationException(); }
        @Override public int update(Uri uri,ContentValues values,String selection,String[] args){ throw new UnsupportedOperationException(); }
    }
    @Before public void setup() throws Exception {
        context=RuntimeEnvironment.getApplication();
        File root = new File(context.getNoBackupFilesDir(),"relay-shares");
        if(root.exists()) for(File file:Objects.requireNonNull(root.listFiles())) assertTrue(file.delete());
        provider=new SourceProvider(); ProviderInfo info=new ProviderInfo(); info.authority="relay-share-test";
        provider.attachInfo(context,info); ShadowContentResolver.registerProviderInternal(info.authority,provider);
        inbox=new ShareInbox(context);
    }
    JSONObject metadata(String value) throws Exception { return new JSONObject().put("scope",value).put("label","My Relay").put("chats",new JSONArray().put(new JSONObject().put("id","main").put("title","Main"))); }
    void sync() throws Exception { inbox.sync(metadata(scope),server); }
    Intent single(Uri uri) { return new Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); }
    Intent multiple(Uri... uris) { return new Intent(Intent.ACTION_SEND_MULTIPLE).setType("*/*").putParcelableArrayListExtra(Intent.EXTRA_STREAM,new ArrayList<>(Arrays.asList(uris))); }
    Intent text(String value) { return new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT,value); }
    JSONObject read(Intent intent) throws Exception { return SharePayload.read(context,intent); }
    interface Throwing { void run() throws Exception; }
    void rejected(Throwing action) throws Exception { try { action.run(); fail("Accepted invalid input"); } catch(IOException|IllegalArgumentException|SecurityException expected) {} }

    @Test public void exactPhotoAndDocumentBytesPersistUntilAcknowledged() throws Exception {
        sync(); Uri photo=provider.add("旅行.png","image/png",PNG), document=provider.add("notes.txt","text/plain","Shared notes 😀".getBytes(StandardCharsets.UTF_8));
        String id=inbox.enqueue(context,multiple(photo,document).putExtra(Intent.EXTRA_TEXT,"For our trip"),server);
        JSONObject item=new ShareInbox(context).peek(scope);
        assertEquals(id,item.getString("id"));assertEquals("For our trip",item.getString("text"));
        assertEquals(2,item.getJSONArray("files").length());
        assertArrayEquals(PNG,Base64.decode(item.getJSONArray("files").getJSONObject(0).getString("base64"),Base64.DEFAULT));
        assertEquals("image/png",item.getJSONArray("files").getJSONObject(0).getString("mime"));
        assertEquals("Shared notes 😀",new String(Base64.decode(item.getJSONArray("files").getJSONObject(1).getString("base64"),Base64.DEFAULT),StandardCharsets.UTF_8));
        assertEquals(item.toString(),new ShareInbox(context).peek(scope).toString());
        inbox.acknowledge(id,scope);inbox.acknowledge(id,scope);assertNull(inbox.peek(scope));
    }
    @Test public void clipDataFallbackAndDuplicateUriAreHandledOnce() throws Exception {
        Uri uri=provider.add("photo.png","image/png",PNG);
        ClipData clip=ClipData.newUri(context.getContentResolver(),"Photo",uri);clip.addItem(new ClipData.Item(uri));
        Intent intent=new Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/*"); intent.setClipData(clip);
        assertEquals(1,read(intent).getJSONArray("files").length());assertEquals(1,provider.opened);
    }
    @Test public void streamExtraTakesPrecedenceOverDuplicatePermissionClip() throws Exception {
        Uri uri=provider.add("photo.png","image/png",PNG);
        Intent intent=single(uri);intent.setClipData(ClipData.newRawUri("Ignore unrelated URI",Uri.parse("https://example.test/private")));
        assertEquals(1,read(intent).getJSONArray("files").length());assertEquals(1,provider.opened);
    }
    @Test public void missingMetadataHasSafeFallbacks() throws Exception {
        Uri uri=provider.add(null,null,PNG);
        JSONObject file=read(single(uri)).getJSONArray("files").getJSONObject(0);
        assertEquals("shared-file-1",file.getString("name"));assertEquals("application/octet-stream",file.getString("mime"));
    }
    @Test public void invalidMimeBecomesOpaqueAttachment() throws Exception {
        Uri uri=provider.add("file.bin","image/png\r\nX-Extra: 1",PNG);
        assertEquals("application/octet-stream",read(single(uri)).getJSONArray("files").getJSONObject(0).getString("mime"));
    }
    @Test public void rejectsPathsAndControlsInProviderNames() throws Exception {
        for(String name:new String[]{"../secret","folder\\secret","a\nb","a\nb\nc",".","..","a\u007fb","x".repeat(241)}) {
            Uri uri=provider.add(name,"text/plain",PNG); rejected(()->read(single(uri)));
        }
        assertEquals(0,provider.opened);
    }
    @Test public void neverOpensFileOrNetworkUris() throws Exception {
        for(String uri:new String[]{"file:///private/secret","https://example.test/file","http://localhost/file","content:///missing-authority"}) rejected(()->read(single(Uri.parse(uri))));
        assertEquals(0,provider.opened);
    }
    @Test public void cannotReadRelaysOwnFileProviderViaExternalIntent() throws Exception {
        rejected(()->read(single(Uri.parse("content://"+context.getPackageName()+".fileprovider/my_cache_images/private.txt"))));
        rejected(()->read(single(Uri.parse("content://0@"+context.getPackageName()+".fileprovider/my_cache_images/private.txt"))));
        assertEquals(0,provider.opened);
    }
    @Test public void validatesTextAndRetainsLinksWithoutFetching() throws Exception {
        assertEquals("https://example.test/path\n😀",read(text("https://example.test/path\n😀")).getString("text"));
        assertEquals(12000,read(text("x".repeat(12000))).getString("text").length());
        rejected(()->read(text("x".repeat(12001))));rejected(()->read(text("  ")));
        assertEquals(0,provider.opened);
    }
    @Test public void fileOnlyAndPlainClipTextWorkWithoutCoercingHtml() throws Exception {
        assertEquals("",read(single(provider.add("empty.txt","text/plain",new byte[0]))).getString("text"));
        Intent intent = new Intent(Intent.ACTION_SEND).setType("text/plain"); intent.setClipData(ClipData.newPlainText("Text","Shared 😀"));
        assertEquals("Shared 😀",read(intent).getString("text"));
        rejected(()->read(new Intent(Intent.ACTION_VIEW)));
    }
    @Test public void rejectsMoreThanEightFilesBeforeOpeningAny() throws Exception {
        Uri[] items=new Uri[9];for(int i=0;i<9;i++)items[i]=provider.add("f"+i,"text/plain",PNG);
        rejected(()->read(multiple(items)));assertEquals(0,provider.opened);
        assertEquals(8,read(multiple(Arrays.copyOf(items,8))).getJSONArray("files").length());
    }
    @Test public void rejectsRevokedGrantWithoutSavingPartialShare() throws Exception {
        sync();Uri ok=provider.add("ok.png","image/png",PNG),missing=provider.add("gone.png","image/png",PNG);
        provider.denied.add(missing.getLastPathSegment());
        rejected(()->inbox.enqueue(context,multiple(ok,missing),server));assertNull(inbox.peek(scope));
    }
    @Test public void combinedByteLimitDoesNotTrustProviderSize() throws Exception {
        sync();Uri first=provider.add("one.bin","application/octet-stream",new byte[SharePayload.MAX_BYTES]),second=provider.add("two.bin","application/octet-stream",new byte[]{1});
        provider.sizes.put(first.getLastPathSegment(),-1L);provider.sizes.put(second.getLastPathSegment(),0L);
        rejected(()->inbox.enqueue(context,multiple(first,second),server));assertNull(inbox.peek(scope));
        assertEquals(2,provider.opened);
    }
    @Test public void exactEightMiBLimitSurvivesJsonAndRestart() throws Exception {
        sync();byte[] bytes=new byte[SharePayload.MAX_BYTES];new Random(17).nextBytes(bytes);
        String id=inbox.enqueue(context,single(provider.add("eight.bin","application/octet-stream",bytes)),server);
        assertArrayEquals(bytes,Base64.decode(new ShareInbox(context).peek(scope).getJSONArray("files").getJSONObject(0).getString("base64"),Base64.DEFAULT));
        inbox.acknowledge(id,scope);assertNull(inbox.peek(scope));
    }
    @Test public void oversizedDeclaredSizeRejectedBeforeOpening() throws Exception {
        Uri uri=provider.add("bad.bin","application/octet-stream",PNG);provider.sizes.put(uri.getLastPathSegment(),(long)SharePayload.MAX_BYTES+1);
        rejected(()->read(single(uri)));assertEquals(0,provider.opened);
    }
    @Test public void workspaceIsFrozenBeforeProviderReadEvenIfContextChanges() throws Exception {
        sync();String other="[\"https://other.example.test\",\"new\"]";
        provider.onOpen=()->{try{inbox.sync(metadata(other),"https://other.example.test");}catch(Exception e){throw new RuntimeException(e);}};
        inbox.enqueue(context,single(provider.add("photo.png","image/png",PNG)),server);
        assertNull(inbox.peek(other));sync();assertNotNull(inbox.peek(scope));
    }
    @Test public void firstShareBindsOnlyToItsReceivingServer() throws Exception {
        inbox.enqueue(context,text("Waiting"),server);
        String other="[\"https://other.example.test\",\"new\"]";
        inbox.sync(metadata(other),"https://other.example.test");assertNull(inbox.peek(other));
        sync();assertEquals(scope,inbox.peek(scope).getString("scope"));
    }
    @Test public void cachedContextOfAnotherServerCannotCaptureNewShare() throws Exception {
        String other="[\"https://other.example.test\",\"new\"]";
        inbox.sync(metadata(other),"https://other.example.test");inbox.enqueue(context,text("Current server"),server);
        assertNull(inbox.peek(other));sync();assertNotNull(inbox.peek(scope));
    }
    @Test public void oldWorkspaceOnSameServerDoesNotReceiveBoundItem() throws Exception {
        sync();String id=inbox.enqueue(context,text("Original workspace"),server);
        String newer="[\"https://relay.example.test\",\"reset\"]";inbox.sync(metadata(newer),server);
        assertNull(inbox.peek(newer));rejected(()->inbox.acknowledge(id,newer));sync();assertNotNull(inbox.peek(scope));
    }
    @Test public void capacityAndAckProtectPrivateInbox() throws Exception {
        sync();for(int i=0;i<12;i++)inbox.enqueue(context,text("Share "+i),server);
        rejected(()->inbox.enqueue(context,single(provider.add("extra.png","image/png",PNG)),server));assertEquals(0,provider.opened);
        rejected(()->inbox.acknowledge("../context",scope));rejected(()->inbox.acknowledge(inbox.peek(scope).getString("id"),"other"));
        inbox.acknowledge(inbox.peek(scope).getString("id"),scope);inbox.enqueue(context,text("Now fits"),server);
    }
    @Test public void abandonedAtomicWriteIsRemovedWithoutLosingCommittedItem() throws Exception {
        sync();String id=inbox.enqueue(context,text("Kept"),server);
        File abandoned=new File(context.getNoBackupFilesDir(),"relay-shares/item-abandoned.json.tmp");
        Files.writeString(abandoned.toPath(),"{interrupted");
        ShareInbox reopened=new ShareInbox(context);assertFalse(abandoned.exists());
        assertEquals(id,reopened.peek(scope).getString("id"));
    }
    @Test public void contextRejectsWrongOriginAndDuplicateChats() throws Exception {
        rejected(()->inbox.sync(metadata(scope),"https://other.example.test"));
        JSONObject data=metadata(scope);data.getJSONArray("chats").put(new JSONObject().put("id","main").put("title","Duplicate"));
        rejected(()->inbox.sync(data,server));
        assertEquals("https://relay.example.test",ShareInbox.origin("https://RELAY.example.test:443/"));
    }
}
