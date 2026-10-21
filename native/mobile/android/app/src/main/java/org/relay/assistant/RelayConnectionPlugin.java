package org.relay.assistant;

import com.getcapacitor.Plugin;
import android.content.Intent;
import android.net.Uri;
import java.net.URI;
import java.util.Objects;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.JSObject;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "RelayConnection")
public class RelayConnectionPlugin extends Plugin {
    @PluginMethod public void status(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            result.put("url", ((MainActivity) getActivity()).connectedServer());
            call.resolve(result);
        });
    }
    @PluginMethod public void openAppSignIn(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                URI root = new URI(((MainActivity)getActivity()).connectedServer());
                URI current = new URI(getBridge().getWebView().getUrl());
                String value = call.getString("url", "");
                URI target = new URI(value);
                Uri parsed = Uri.parse(value);
                if (!sameOrigin(root, current) || !"/".equals(current.getPath()) || !sameOrigin(root, target) || target.getUserInfo() != null || target.getFragment() != null || !("/api/connectors/oauth/open".equals(target.getPath()) || "/api/models/oauth/open".equals(target.getPath())) || parsed.getQueryParameterNames().size() != 2 || parsed.getQueryParameters("id").size() != 1 || parsed.getQueryParameters("ticket").size() != 1 || !parsed.getQueryParameter("id").matches("[a-f0-9-]{36}") || !parsed.getQueryParameter("ticket").matches("[A-Za-z0-9_-]{43}")) throw new Exception();
                getActivity().startActivity(new Intent(Intent.ACTION_VIEW, parsed));
                call.resolve();
            } catch (Exception error) { call.reject("Open app sign-in from the Relay workspace."); }
        });
    }
    private int port(URI url) { return url.getPort() >= 0 ? url.getPort() : "https".equals(url.getScheme()) ? 443 : 80; }
    private boolean sameOrigin(URI a, URI b) {
        return Objects.equals(a.getScheme(), b.getScheme()) && Objects.equals(a.getHost(), b.getHost()) && port(a) == port(b);
    }
    @PluginMethod public void show(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ((MainActivity) getActivity()).showConnection(call.getString("locale"));
            call.resolve();
        });
    }
}
