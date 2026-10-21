package org.relay.assistant;

import android.content.Context;
import android.content.Intent;
import org.json.*;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;

final class ShareInbox {
    private final File root;
    private static final Object LOCK = new Object();
    // 8 MiB of base64 plus bounded text/metadata. Context has a separate smaller limit.
    private static final int ITEM_LIMIT = 12 * 1024 * 1024;
    ShareInbox(Context context) throws IOException {
        root = new File(context.getNoBackupFilesDir(), "relay-shares");
        synchronized (LOCK) {
            if (!root.isDirectory() && !root.mkdirs()) throw new SharePayload.Failure("Sharing is unavailable.");
            // Only a crashed write leaves a temporary file; active writes hold this same lock.
            File[] abandoned = root.listFiles((dir,name)->name.endsWith(".json.tmp"));
            if (abandoned != null) for (File file : abandoned)
                if (!file.delete()) throw new SharePayload.Failure("Could not recover sharing. Reopen Relay and try again.");
        }
    }
    private JSONObject read(File path) throws Exception {
        int limit = path.getName().equals("context.json") ? 512000 : ITEM_LIMIT;
        if (path.length() > limit) throw new SharePayload.Failure("This share is too large.");
        try (FileInputStream in = new FileInputStream(path); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384]; int count;
            while ((count = in.read(buffer)) != -1) { if (bytes.size() + count > limit) throw new SharePayload.Failure("This share is too large."); bytes.write(buffer, 0, count); }
            return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        }
    }
    private void write(File file, JSONObject value) throws Exception {
        byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > (file.getName().equals("context.json") ? 512000 : ITEM_LIMIT)) throw new SharePayload.Failure("This share is too large.");
        File temporary = new File(root, file.getName()+".tmp");
        try {
            try (FileOutputStream out = new FileOutputStream(temporary)) { out.write(bytes); out.getFD().sync(); }
            if (!temporary.renameTo(file)) throw new SharePayload.Failure("Could not keep the shared item.");
        } finally { if (temporary.exists()) temporary.delete(); }
    }
    static String origin(String address) throws Exception {
        URI uri = new URI(address.isEmpty() ? "https://localhost" : address);
        String scheme = uri.getScheme(), host = uri.getHost(); int port = uri.getPort();
        if (scheme == null || host == null || !(scheme.equals("https") || scheme.equals("http"))) throw new SharePayload.Failure("Open your Relay workspace first.");
        return scheme + "://" + host.toLowerCase(Locale.ROOT) + (port == -1 || (port == 443 && scheme.equals("https")) || (port == 80 && scheme.equals("http")) ? "" : ":" + port);
    }
    private static String scopeOrigin(String scope) throws Exception {
        JSONArray values = new JSONArray(scope);
        if (values.length() != 2 || values.getString(1).isEmpty()) throw new SharePayload.Failure("Open your Relay workspace first.");
        return origin(values.getString(0));
    }
    void sync(JSONObject context, String expectedOrigin) throws Exception {
        synchronized (LOCK) {
            String scope = context.getString("scope"), label = context.getString("label");
            JSONArray chats = context.getJSONArray("chats");
            if (scope.isEmpty() || scope.length()>1000 || label.length()>300 || chats.length()>200 || !scopeOrigin(scope).equals(origin(expectedOrigin))) throw new SharePayload.Failure("Open Relay to refresh your chats.");
            Set<String> ids = new HashSet<>();
            for (int i=0;i<chats.length();i++) {
                JSONObject row=chats.getJSONObject(i);
                if (!ShareText.validId(row.getString("id")) || !ids.add(row.getString("id")) || row.getString("title").length()>500) throw new SharePayload.Failure("A chat could not be read.");
            }
            write(new File(root,"context.json"),context);
        }
    }
    private void checkCapacity() throws IOException {
        File[] files = root.listFiles((dir,name)->name.startsWith("item-")&&name.endsWith(".json"));
        if (files == null) throw new SharePayload.Failure("Sharing is unavailable.");
        if (files.length >= 12) throw new SharePayload.Failure("Open Relay to attach or discard waiting shares first.");
    }
    String enqueue(Context context, Intent intent, String server) throws Exception {
        String scope = "", expectedOrigin = origin(server);
        synchronized (LOCK) {
            checkCapacity();
            File metadata = new File(root,"context.json");
            if (metadata.exists()) {
                String cached = read(metadata).getString("scope");
                if (scopeOrigin(cached).equals(expectedOrigin)) scope = cached;
            }
        }
        // Freeze the workspace before touching a provider. No partial item is visible on failure.
        JSONObject item = SharePayload.read(context, intent);
        synchronized (LOCK) {
            checkCapacity();
            String id = UUID.randomUUID().toString();
            item.put("id",id).put("scope",scope).put("origin",expectedOrigin);
            write(new File(root,"item-"+id+".json"),item);
            return id;
        }
    }
    JSONObject peek(String scope) throws Exception {
        synchronized (LOCK) {
            if (!read(new File(root,"context.json")).getString("scope").equals(scope)) throw new SharePayload.Failure("Refresh the matching workspace.");
            File[] files=root.listFiles((dir,name)->name.startsWith("item-")&&name.endsWith(".json"));
            if (files==null)return null;
            Arrays.sort(files,Comparator.comparingLong(File::lastModified).thenComparing(File::getName));
            for (File file:files) {
                JSONObject item=read(file);
                if (item.getString("scope").isEmpty()) {
                    // Legacy text-only receipts have no origin. New ones bind only on their original server.
                    if (item.has("origin") && !item.getString("origin").equals(scopeOrigin(scope))) continue;
                    item.put("scope",scope);write(file,item);
                }
                if(item.getString("scope").equals(scope))return item;
            }
            return null;
        }
    }
    void acknowledge(String id,String scope) throws Exception {
        synchronized (LOCK) {
            if (!ShareText.validId(id)) throw new SharePayload.Failure("Invalid share receipt.");
            if (!read(new File(root,"context.json")).getString("scope").equals(scope)) throw new SharePayload.Failure("Refresh the matching workspace.");
            File file=new File(root,"item-"+id+".json");
            if(!file.exists())return;
            if(!read(file).getString("scope").equals(scope))throw new SharePayload.Failure("That share belongs to another workspace.");
            if(!file.delete())throw new SharePayload.Failure("Could not finish this share. Try again.");
        }
    }
}
