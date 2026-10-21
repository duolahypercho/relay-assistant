package org.relay.assistant;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.pm.ProviderInfo;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Parcelable;
import android.provider.OpenableColumns;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Copies only explicitly shared content URIs. Shared links remain inert text. */
final class SharePayload {
    static final int MAX_BYTES = 8 * 1024 * 1024;
    static final int MAX_FILES = 8;
    private static final ScheduledExecutorService TIMEOUTS = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "relay-share-timeout"); thread.setDaemon(true); return thread;
    });

    static boolean accepts(Intent intent) {
        return intent != null && (Intent.ACTION_SEND.equals(intent.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction()));
    }

    @SuppressWarnings("deprecation")
    static JSONObject read(Context context, Intent intent) throws Exception {
        ContentResolver resolver = context.getContentResolver();
        if (!accepts(intent)) throw new Failure("Choose a photo, file or text to share.");
        CharSequence supplied = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String text = supplied == null ? "" : supplied.toString();
        if (text.length() > 12000) throw new Failure("Share text of up to 12,000 characters.");
        Set<Uri> uris = new LinkedHashSet<>();
        if (intent.hasExtra(Intent.EXTRA_STREAM)) {
            if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
                ArrayList<Parcelable> items = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (items == null || items.size() > MAX_FILES) throw new Failure("Share up to eight files at a time.");
                for (Parcelable item : items) add(uris, item);
            } else add(uris, intent.getParcelableExtra(Intent.EXTRA_STREAM));
        } else {
            ClipData clip = intent.getClipData();
            if (clip != null) {
                if (clip.getItemCount() > MAX_FILES) throw new Failure("Share up to eight files at a time.");
                for (int i = 0; i < clip.getItemCount(); i++) {
                    ClipData.Item item = clip.getItemAt(i);
                    if (item.getUri() != null) add(uris, item.getUri());
                    // Do not coerce HTML, nested intents, or URI contents into text.
                    else if (supplied == null && item.getText() != null) {
                        text += (text.isEmpty() ? "" : "\n") + item.getText();
                        if (text.length() > 12000) throw new Failure("Share text of up to 12,000 characters.");
                    }
                }
            }
        }
        if (uris.isEmpty() && text.trim().isEmpty()) throw new Failure("Choose a photo, file or text to share.");
        JSONArray files = new JSONArray();
        int remaining = MAX_BYTES;
        CancellationSignal cancellation = new CancellationSignal();
        var timeout = TIMEOUTS.schedule(cancellation::cancel, 30, TimeUnit.SECONDS);
        try {
            for (Uri uri : uris) {
                cancellation.throwIfCanceled();
                String authority = uri.getAuthority();
                authority = authority.substring(authority.lastIndexOf('@') + 1);
                ProviderInfo source = context.getPackageManager().resolveContentProvider(authority, 0);
                if (authority.equalsIgnoreCase(context.getPackageName() + ".fileprovider") ||
                    (source != null && source.applicationInfo != null && source.applicationInfo.uid == android.os.Process.myUid()))
                    throw new Failure("Choose a file from another app or attach it inside Relay.");
                String name = "shared-file-" + (files.length() + 1);
                try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null, cancellation)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                        if (nameColumn >= 0 && !cursor.isNull(nameColumn)) name = cursor.getString(nameColumn);
                        if (sizeColumn >= 0 && !cursor.isNull(sizeColumn) && cursor.getLong(sizeColumn) > remaining)
                            throw new Failure("Share files totaling 8 MB or less.");
                    }
                }
                if (name == null || name.isEmpty() || name.length() > 240 || name.equals(".") || name.equals("..") || name.matches("(?s).*[/\\\\\\x00-\\x1f\\x7f].*"))
                    throw new Failure("A shared file has an unsupported name. Rename it and try again.");
                String mime = resolver.getType(uri);
                if (mime == null || mime.length() > 120 || !mime.matches("[\\w.+-]+/[\\w.+-]+")) mime = "application/octet-stream";
                try (AssetFileDescriptor descriptor = resolver.openAssetFileDescriptor(uri, "r", cancellation)) {
                    if (descriptor == null) throw new Failure("A shared file is no longer available. Share it again.");
                    cancellation.setOnCancelListener(() -> { try { descriptor.close(); } catch (IOException ignored) {} });
                    try (InputStream input = descriptor.createInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                        byte[] buffer = new byte[16384]; int count;
                        while ((count = input.read(buffer)) != -1) {
                            cancellation.throwIfCanceled();
                            if (count > remaining - bytes.size()) throw new Failure("Share files totaling 8 MB or less.");
                            bytes.write(buffer, 0, count);
                        }
                        remaining -= bytes.size();
                        files.put(new JSONObject().put("name", name).put("mime", mime).put("base64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)));
                    }
                }
            }
            cancellation.setOnCancelListener(null);
            cancellation.throwIfCanceled();
            return new JSONObject().put("text", text).put("files", files);
        } finally { timeout.cancel(false); cancellation.setOnCancelListener(null); }
    }

    static final class Failure extends IOException { Failure(String message) { super(message); } }

    private static void add(Set<Uri> uris, Object value) throws IOException {
        if (!(value instanceof Uri) || !"content".equals(((Uri) value).getScheme()) || ((Uri) value).getAuthority() == null)
            throw new Failure("Share files directly from an app using Android’s share button.");
        uris.add((Uri) value);
        if (uris.size() > MAX_FILES) throw new Failure("Share up to eight files at a time.");
    }
}
