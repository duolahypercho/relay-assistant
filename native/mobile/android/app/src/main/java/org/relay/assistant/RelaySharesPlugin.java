package org.relay.assistant;

import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.URI;
import org.json.*;

@CapacitorPlugin(name="RelayShares")
public class RelaySharesPlugin extends Plugin {
    @PluginMethod public void peekTemplate(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                String origin=workspace();
                var preferences=getContext().getSharedPreferences(MainActivity.PREFERENCES, android.content.Context.MODE_PRIVATE);
                String raw=preferences.getString("pending-template", ""); JSObject result=new JSObject();
                if (!raw.isEmpty()) {
                    JSONObject item=new JSONObject(raw);
                    if (item.optString("destination").isEmpty()) { item.put("destination",origin); preferences.edit().putString("pending-template",item.toString()).commit(); }
                    if (origin.equals(item.getString("destination"))) result.put("item",new JSONObject().put("id",item.getString("id")).put("url",item.getString("url")));
                }
                call.resolve(result);
            } catch(Exception error) { call.reject("Open the matching Relay workspace to review this template."); }
        });
    }
    @PluginMethod public void acknowledgeTemplate(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                String origin=workspace(); var preferences=getContext().getSharedPreferences(MainActivity.PREFERENCES, android.content.Context.MODE_PRIVATE);
                String raw=preferences.getString("pending-template", "");
                if (!raw.isEmpty()) { JSONObject item=new JSONObject(raw); if (origin.equals(item.getString("destination")) && item.getString("id").equals(call.getString("id"))) preferences.edit().remove("pending-template").commit(); }
                call.resolve();
            } catch(Exception error) { call.reject("Open the matching Relay workspace to finish this template review."); }
        });
    }
    private String workspace() throws Exception {
        URI current=new URI(getBridge().getWebView().getUrl());
        String expected=ShareInbox.origin(((MainActivity)getActivity()).connectedServer());
        if (!ShareInbox.origin(current.toString()).equals(expected) || !(current.getPath().isEmpty()||current.getPath().equals("/")||current.getPath().equals("/index.html")))
            throw new Exception("Open the main Relay workspace to use sharing.");
        return expected;
    }
    private interface Operation { JSObject run(ShareInbox inbox, String origin) throws Exception; }
    private void perform(PluginCall call, Operation operation) {
        getActivity().runOnUiThread(() -> {
            try {
                String origin = workspace();
                android.content.Context context = getContext().getApplicationContext();
                ShareWork.IO.execute(() -> {
                    try {
                        JSObject result = operation.run(new ShareInbox(context), origin);
                        getActivity().runOnUiThread(() -> {
                            try {
                                if (!workspace().equals(origin)) throw new Exception("Workspace changed.");
                                call.resolve(result);
                            } catch(Exception error) { call.reject("Reopen the matching Relay workspace to finish sharing."); }
                        });
                    } catch(Exception error) { call.reject("Could not finish sharing. Open the matching workspace and try again."); }
                });
            } catch(Exception error) { call.reject("Sharing is busy or unavailable. Open Relay and try again."); }
        });
    }
    @PluginMethod public void sync(PluginCall call) {
        perform(call, (inbox, origin) -> {
            inbox.sync(new JSONObject().put("scope",call.getString("scope")).put("label",call.getString("label")).put("chats",call.getArray("chats")), origin);
            return new JSObject();
        });
    }
    @PluginMethod public void peek(PluginCall call) {
        perform(call, (inbox, origin) -> {
            String scope = call.getString("scope");
            if (!ShareInbox.origin(new JSONArray(scope).getString(0)).equals(origin)) throw new Exception("Workspace changed.");
            JSONObject item = inbox.peek(scope); JSObject result = new JSObject();
            if (item != null) result.put("item",item);
            return result;
        });
    }
    @PluginMethod public void acknowledge(PluginCall call) {
        perform(call, (inbox, origin) -> {
            String scope = call.getString("scope");
            if (!ShareInbox.origin(new JSONArray(scope).getString(0)).equals(origin)) throw new Exception("Workspace changed.");
            inbox.acknowledge(call.getString("id"),scope);
            return new JSObject();
        });
    }
}
