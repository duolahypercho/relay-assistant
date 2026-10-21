package org.relay.assistant;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import com.getcapacitor.WebViewListener;
import android.webkit.WebView;
import android.view.View;
import android.content.SharedPreferences;
import android.content.Intent;
import android.widget.Toast;
import android.content.DialogInterface;
import android.widget.EditText;
import android.text.InputType;
import android.os.Bundle;
import androidx.appcompat.app.AlertDialog;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    static final String PREFERENCES = "relay-connection";
    static final String SERVER = "server";
    private static String pendingConnectionLink = null;
    private View recoveryView;

    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RelayConnectionPlugin.class);
        registerPlugin(RelayResultsPlugin.class);
        registerPlugin(RelaySharesPlugin.class);
        super.onCreate(savedInstanceState);
        if (savedInstanceState == null) receiveShare(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        receiveShare(intent);
    }
    private void receiveShare(Intent intent) {
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction())) {
            try {
                String url = TemplateLink.parse(intent.getDataString(), isDevelopment());
                String server = connectedServer();
                JSONObject item = new JSONObject().put("id", java.util.UUID.randomUUID().toString()).put("url", url).put("destination", server.isEmpty() ? "" : ShareInbox.origin(server));
                getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit().putString("pending-template", item.toString()).commit();
                intent.setData(null); intent.setAction(Intent.ACTION_MAIN); setIntent(intent);
            } catch (Exception ignored) { /* Invalid links never replace a pending review or server. */ }
            return;
        }
        if (!SharePayload.accepts(intent)) return;
        final Intent incoming = new Intent(intent);
        final String server = connectedServer();
        final android.content.Context context = getApplicationContext();
        try {
            ShareWork.IO.execute(() -> {
                try { new ShareInbox(context).enqueue(context, incoming, server); }
                catch (Exception error) {
                    // Provider errors can contain private paths or arbitrary app-controlled text.
                    String message = error instanceof SharePayload.Failure ? error.getMessage() : "This share could not be read. Share it again from the original app.";
                    runOnUiThread(() -> Toast.makeText(context, message == null ? "This share could not be saved. Try again." : message, Toast.LENGTH_LONG).show());
                }
            });
            // The private copy retains the granted URI until the worker finishes. Configuration
            // changes must not deliver this same intent again. New share intents remain distinct.
            intent.removeExtra(Intent.EXTRA_TEXT);
            intent.removeExtra(Intent.EXTRA_STREAM);
            intent.setClipData(null);
            intent.setAction(Intent.ACTION_MAIN);
            setIntent(intent);
        } catch (java.util.concurrent.RejectedExecutionException error) {
            Toast.makeText(this, "Relay is still reading shared items. Try sharing again shortly.", Toast.LENGTH_LONG).show();
        }
    }

    @Override protected void load() {
        CapConfig defaults = CapConfig.loadDefault(this);
        SharedPreferences preferences = getSharedPreferences(PREFERENCES, MODE_PRIVATE);
        String address = preferences.getString(SERVER, defaults.getServerUrl());
        try { address = ServerAddress.validate(address, isDevelopment()); }
        catch (IllegalArgumentException error) { address = ""; }
        JSONObject plugins = new JSONObject();
        try (var stream = getAssets().open("capacitor.config.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            while ((count = stream.read(buffer)) != -1) bytes.write(buffer, 0, count);
            JSONObject configured = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            if (configured.optJSONObject("plugins") != null) plugins = configured.getJSONObject("plugins");
        } catch (Exception ignored) { }
        String target = pendingConnectionLink == null ? address : pendingConnectionLink;
        pendingConnectionLink = null;
        config = new CapConfig.Builder(this)
            .setServerUrl(target.isEmpty() ? null : target)
            .setErrorPath("native-connection.html")
            .setPluginsConfiguration(plugins)
            .create();
        // Capacitor's Android error page has no plugin bridge. Keep recovery controls
        // native and scoped to that exact bundled page; never expose another JS bridge.
        bridgeBuilder.addWebViewListener(new WebViewListener() {
            private void recover(WebView webView) {
                if (bridge != null && bridge.getErrorUrl() != null && bridge.getErrorUrl().equals(webView.getUrl())) {
                    showRecovery(webView);
                }
            }
            @Override public void onPageStarted(WebView webView) { recover(webView); }
            @Override public void onPageLoaded(WebView webView) { recover(webView); }
        });
        super.load();
    }

    String connectedServer() { return getSharedPreferences(PREFERENCES, MODE_PRIVATE).getString(SERVER, config.getServerUrl() == null ? "" : config.getServerUrl().split("#", 2)[0]); }
    private boolean isDevelopment() { return (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0; }

    private java.util.function.Function<String, String> connectionCopy(String preferredLocale) {
        String locale = ConnectionLocale.resolve(preferredLocale, getResources().getConfiguration().getLocales().toLanguageTags());
        JSONObject copy;
        try (var stream = getAssets().open("public/native-connection-language.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096]; int count;
            while ((count = stream.read(buffer)) != -1) {
                if (bytes.size() + count > 65536) throw new java.io.IOException("Bundled copy is too large");
                bytes.write(buffer, 0, count);
            }
            copy = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        } catch (Exception error) { copy = new JSONObject(); }
        final JSONObject translations = copy;
        return key -> {
            int index = locale.equals("zh-CN") ? 0 : locale.equals("zh-TW") ? 1 : -1;
            var entry = translations.optJSONArray(key);
            return index >= 0 && entry != null && entry.length() == 2 ? entry.optString(index, key) : key;
        };
    }

    private void showRecovery(WebView webView) {
        if (recoveryView != null) return;
        recoveryView = ConnectionRecoveryView.create(this, connectionCopy(null), connectedServer(),
            () -> recreate(), () -> showConnection(null));
        webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        webView.setVisibility(View.INVISIBLE);
        addContentView(recoveryView, new android.view.ViewGroup.LayoutParams(
            android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT));
    }

    void showConnection(String preferredLocale) {
        var text = connectionCopy(preferredLocale);
        EditText field = new EditText(this);
        field.setSingleLine(true);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setHint("https://relay.example.com");
        field.setText(connectedServer());
        field.setContentDescription(text.apply("Relay server address"));
        android.widget.LinearLayout form = new android.widget.LinearLayout(this);
        form.setOrientation(android.widget.LinearLayout.VERTICAL);
        form.addView(field, new android.widget.LinearLayout.LayoutParams(
            android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.WRAP_CONTENT));
        android.widget.TextView validation = new android.widget.TextView(this);
        validation.setTextColor(android.graphics.Color.rgb(170, 35, 45));
        validation.setTextSize(14);
        validation.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        validation.setVisibility(View.GONE);
        form.addView(validation, new android.widget.LinearLayout.LayoutParams(
            android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.WRAP_CONTENT));
        field.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
                validation.setText("");
                validation.setVisibility(View.GONE);
            }
            @Override public void afterTextChanged(android.text.Editable editable) { }
        });
        int margin = Math.round(24 * getResources().getDisplayMetrics().density);
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle(text.apply("Connect your devices"))
            .setMessage(text.apply("Paste a connection link from your other device, or enter your server’s HTTPS address. A link lets you join without copying the owner key."))
            .setView(form, margin, margin / 2, margin, 0)
            .setNegativeButton(text.apply("Cancel"), null)
            .setNeutralButton(text.apply("Use sample"), (d, button) -> connect(""))
            .setPositiveButton(text.apply("Connect"), null)
            .create();
        dialog.setOnShowListener((d) -> dialog.getButton(DialogInterface.BUTTON_POSITIVE).setOnClickListener((view) -> {
            try {
                String[] input = ServerAddress.connectionInput(field.getText().toString(), isDevelopment());
                String address = input[0];
                if (address.isEmpty()) throw new IllegalArgumentException(ServerAddress.MESSAGE);
                pendingConnectionLink = input[1].isEmpty() ? null : input[1];
                dialog.dismiss();
                connect(address);
            } catch (IllegalArgumentException error) {
                validation.setText(text.apply(error.getMessage()));
                validation.setVisibility(View.VISIBLE);
            }
        }));
        dialog.show();
    }

    private void connect(String address) {
        getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit().putString(SERVER, address).apply();
        recreate();
    }
}
