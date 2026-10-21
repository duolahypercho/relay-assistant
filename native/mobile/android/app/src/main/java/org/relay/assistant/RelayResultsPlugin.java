package org.relay.assistant;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.*;
import android.widget.*;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "RelayResults")
public class RelayResultsPlugin extends Plugin {
    private boolean saving;
    private BackupContent backup;
    @Override public void load() { BackupContent.cleanAbandoned(getContext().getCacheDir()); }
    private void discardBackup() { if (backup != null) { try { backup.close(); } catch (Exception ignored) {} backup = null; } }
    @PluginMethod public void beginBackup(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (saving || backup != null || previewDialog != null) { call.reject("Finish the current save first."); return; }
            try { backup = new BackupContent(getContext().getCacheDir()); call.resolve(new JSObject().put("id", backup.id)); }
            catch (Exception error) { call.reject("The backup could not be prepared on this device."); }
        });
    }
    @PluginMethod public void appendBackup(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Double offset = call.getDouble("offset");
            if (saving || backup == null || !backup.id.equals(call.getString("id")) || offset == null || !Double.isFinite(offset) || offset < 0 || offset > BackupContent.MAXIMUM || offset != Math.floor(offset)) { call.reject("This backup save expired."); return; }
            try { long bytes = backup.append(offset.longValue(), call.getString("base64"), value -> android.util.Base64.decode(value, android.util.Base64.NO_WRAP), value -> android.util.Base64.encodeToString(value, android.util.Base64.NO_WRAP)); call.resolve(new JSObject().put("bytes", bytes)); }
            catch (Exception error) { call.reject("The backup transfer is incomplete or out of order."); }
        });
    }
    @PluginMethod public void cancelBackup(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (saving || backup == null || !backup.id.equals(call.getString("id"))) { call.reject("This backup save expired."); return; }
            discardBackup(); call.resolve(new JSObject().put("status", "cancelled"));
        });
    }
    @PluginMethod public void saveBackup(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Double size = call.getDouble("size");
            if (saving || backup == null || !backup.id.equals(call.getString("id")) || size == null || !Double.isFinite(size) || size < 60 || size > BackupContent.MAXIMUM || size != Math.floor(size)) { call.reject("Wait for the complete backup before saving."); return; }
            try {
                backup.finish(size.longValue()); saving = true;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, "Relay-computer.relaybackup");
                startActivityForResult(call, intent, "savedBackup");
            } catch (Exception error) { saving = false; discardBackup(); call.reject("The backup could not be prepared for saving."); }
        });
    }
    @ActivityCallback private void savedBackup(PluginCall call, ActivityResult result) {
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (call == null || backup == null || result.getResultCode() != Activity.RESULT_OK || uri == null) {
            saving = false; discardBackup(); if (call != null) call.resolve(new JSObject().put("status", "cancelled")); return;
        }
        final BackupContent file = backup;
        getBridge().execute(() -> {
            boolean completed = false;
            try { try (java.io.InputStream input = new java.io.FileInputStream(file.file); OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (output == null) throw new java.io.IOException("Missing destination");
                byte[] buffer = new byte[65536]; int length;
                while ((length = input.read(buffer)) != -1) output.write(buffer, 0, length);
            } completed = true;
            } catch (Exception ignored) {}
            final boolean saved = completed;
            getActivity().runOnUiThread(() -> { saving = false; discardBackup(); if (saved) call.resolve(new JSObject().put("status", "saved")); else call.reject("The backup could not be saved. Choose another location and try again."); });
        });
    }
    private Dialog previewDialog;
    private WebView previewWeb;

    @PluginMethod public void save(PluginCall call) {
        try { ResultContent.file(call.getString("name"), call.getString("base64"), value -> android.util.Base64.decode(value, android.util.Base64.NO_WRAP)); }
        catch (IllegalArgumentException error) { call.reject("Choose a valid file of 8 MB or less."); return; }
        getActivity().runOnUiThread(() -> {
            if (saving || backup != null || previewDialog != null) { call.reject("Close the current screen first."); return; }
            String mime = call.getString("mime", "application/octet-stream");
            if (!mime.matches("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+")) mime = "application/octet-stream";
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, call.getString("name"));
            saving = true;
            try { startActivityForResult(call, intent, "savedFile"); }
            catch (Exception error) { saving = false; call.reject("The system file picker is unavailable."); }
        });
    }
    @ActivityCallback private void savedFile(PluginCall call, ActivityResult result) {
        if (call == null) { saving = false; return; }
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            saving = false;
            call.resolve(new JSObject().put("status", "cancelled"));
            return;
        }
        // The system picker grants this single URI; no broad storage permission is used.
        getBridge().execute(() -> {
            try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (output == null) throw new java.io.IOException("Missing destination");
                output.write(ResultContent.file(call.getString("name"), call.getString("base64"), value -> android.util.Base64.decode(value, android.util.Base64.NO_WRAP)));
            } catch (Exception error) {
                getActivity().runOnUiThread(() -> { saving = false; call.reject("The file could not be saved. Choose another location and try again."); });
                return;
            }
            getActivity().runOnUiThread(() -> { saving = false; call.resolve(new JSObject().put("status", "saved")); });
        });
    }
    @PluginMethod public void preview(PluginCall call) {
        String source = call.getString("source");
        if (source == null || source.length() > 200000) { call.reject("This preview is too large."); return; }
        getActivity().runOnUiThread(() -> {
            if (previewDialog != null || saving || backup != null) { call.reject("Close the current screen first."); return; }
            Dialog dialog = new Dialog(getActivity(), android.R.style.Theme_Material_Light_NoActionBar);
            dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
            LinearLayout layout = new LinearLayout(getActivity());
            layout.setOrientation(LinearLayout.VERTICAL);
            layout.setBackgroundColor(Color.WHITE);
            LinearLayout toolbar = new LinearLayout(getActivity());
            Button back = new Button(getActivity()); back.setText("Back");
            Button stop = new Button(getActivity()); stop.setText("Stop");
            Button restart = new Button(getActivity()); restart.setText("Restart");
            toolbar.addView(back); toolbar.addView(stop); toolbar.addView(restart);
            TextView title = new TextView(getActivity());
            String label = call.getString("title", "Preview");
            title.setText(label.substring(0, Math.min(label.length(), 120)));
            title.setTextColor(Color.BLACK); title.setPadding(16, 8, 16, 8);
            FrameLayout content = new FrameLayout(getActivity());
            TextView message = new TextView(getActivity()); message.setText("Preview stopped. Tap Restart to open it again."); message.setTextColor(Color.BLACK); message.setPadding(20, 20, 20, 20);
            content.addView(message);
            layout.addView(toolbar); layout.addView(title); layout.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
            dialog.setContentView(layout);
            previewDialog = dialog;
            Runnable start = () -> {
                stopPreview();
                WebView web = new WebView(getActivity());
                // A plain WebView: never use Bridge.getWebView() or addJavascriptInterface.
                WebSettings settings = web.getSettings();
                settings.setJavaScriptEnabled(true);
                settings.setDomStorageEnabled(false);
                settings.setBlockNetworkLoads(true);
                settings.setGeolocationEnabled(false);
                settings.setAllowFileAccess(false);
                settings.setAllowContentAccess(false);
                settings.setAllowFileAccessFromFileURLs(false);
                settings.setAllowUniversalAccessFromFileURLs(false);
                settings.setJavaScriptCanOpenWindowsAutomatically(false);
                settings.setSupportMultipleWindows(false);
                settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
                CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
                web.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
                    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                    }
                });
                web.setWebChromeClient(new WebChromeClient() {
                    @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
                    @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) { callback.invoke(origin, false, false); }
                    @Override public boolean onJsAlert(WebView view, String url, String text, JsResult result) { result.cancel(); return true; }
                    @Override public boolean onJsConfirm(WebView view, String url, String text, JsResult result) { result.cancel(); return true; }
                    @Override public boolean onJsPrompt(WebView view, String url, String text, String initial, JsPromptResult result) { result.cancel(); return true; }
                });
                web.setDownloadListener((url, userAgent, disposition, mime, length) -> {});
                previewWeb = web;
                content.addView(web, new FrameLayout.LayoutParams(-1, -1));
                web.loadDataWithBaseURL(null, ResultContent.page(source), "text/html", "UTF-8", null);
            };
            back.setOnClickListener(v -> dialog.dismiss());
            stop.setOnClickListener(v -> stopPreview());
            restart.setOnClickListener(v -> start.run());
            dialog.setOnDismissListener(d -> { stopPreview(); previewDialog = null; });
            dialog.show();
            dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            start.run();
            call.resolve();
        });
    }
    private void stopPreview() {
        if (previewWeb == null) return;
        previewWeb.stopLoading();
        if (previewWeb.getParent() instanceof ViewGroup) ((ViewGroup) previewWeb.getParent()).removeView(previewWeb);
        previewWeb.destroy(); previewWeb = null;
    }
    @Override protected void handleOnDestroy() {
        if (previewDialog != null) previewDialog.dismiss();
        stopPreview(); discardBackup(); super.handleOnDestroy();
    }
}
