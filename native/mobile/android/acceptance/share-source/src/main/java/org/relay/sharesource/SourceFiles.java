package org.relay.sharesource;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Base64;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Private provider in a separate APK/UID; access requires the chooser's temporary URI grant. */
public class SourceFiles extends ContentProvider {
    private static final String PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIuoAAAAASUVORK5CYII=";
    private boolean photo(Uri uri) {
        if (!"org.relay.sharesource.files".equals(uri.getAuthority()) || !("/photo".equals(uri.getPath()) || "/document".equals(uri.getPath())))
            throw new IllegalArgumentException("Unknown fixture file");
        return "/photo".equals(uri.getPath());
    }
    private byte[] bytes(Uri uri) {
        return photo(uri) ? Base64.decode(PNG, Base64.DEFAULT) : "Actual Android shared file bytes.".getBytes(StandardCharsets.UTF_8);
    }
    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return photo(uri) ? "image/png" : "text/plain"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        MatrixCursor cursor = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[]{photo(uri) ? "android-share.png" : "android-share.txt", bytes(uri).length});
        return cursor;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Read only");
        File path = new File(getContext().getCacheDir(), photo(uri) ? "photo.png" : "document.txt");
        try (FileOutputStream out = new FileOutputStream(path)) { out.write(bytes(uri)); }
        catch (IOException error) { throw new FileNotFoundException("Fixture unavailable"); }
        return ParcelFileDescriptor.open(path, ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
