package org.relay.sharesource;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.Arrays;

/** Standalone, unshipped fixture: ordinary Android source app and actual system chooser. */
public class ShareSourceActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(36, 100, 36, 36);
        TextView title = new TextView(this);
        title.setText("Relay acceptance source\nFictional test material only");
        title.setTextSize(24);
        layout.addView(title);
        Button files = new Button(this);
        files.setText("Share photo and file");
        files.setContentDescription("Share photo and file");
        files.setOnClickListener(view -> {
            Uri photo = Uri.parse("content://org.relay.sharesource.files/photo");
            Uri file = Uri.parse("content://org.relay.sharesource.files/document");
            Intent share = new Intent(Intent.ACTION_SEND_MULTIPLE).setType("*/*");
            share.putExtra(Intent.EXTRA_TEXT, "A real Android shared note\nhttps://example.invalid/android-share");
            share.putParcelableArrayListExtra(Intent.EXTRA_STREAM, new ArrayList<>(Arrays.asList(photo, file)));
            ClipData clip = ClipData.newUri(getContentResolver(), "Test photo", photo);
            clip.addItem(new ClipData.Item(file));
            share.setClipData(clip);
            share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(share, "Share test files"));
        });
        layout.addView(files);
        Button text = new Button(this);
        text.setText("Share text only");
        text.setContentDescription("Share text only");
        text.setOnClickListener(view -> startActivity(Intent.createChooser(
            new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "A second Android note"), "Share test text")));
        layout.addView(text);
        setContentView(layout);
    }
}
