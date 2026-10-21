// SPDX-License-Identifier: MIT
package org.relay.assistant;

import android.content.Context;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.function.Function;

/** Offline controls deliberately live outside the unavailable WebView plugin bridge. */
final class ConnectionRecoveryView {
    private ConnectionRecoveryView() { }

    static View create(Context context, Function<String, String> text, String server, Runnable retry, Runnable change) {
        int space = Math.round(24 * context.getResources().getDisplayMetrics().density);
        ScrollView scroll = new ScrollView(context);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.WHITE);
        LinearLayout content = new LinearLayout(context);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_VERTICAL);
        content.setPadding(space, space * 2, space, space * 2);
        scroll.addView(content, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = label(context, text.apply("Let’s reconnect."), 28);
        androidx.core.view.ViewCompat.setAccessibilityHeading(title, true);
        content.addView(title);
        TextView description = label(context, text.apply("Your assistant’s server is unreachable. Your conversations and work stay saved there."), 17);
        description.setPadding(0, space, 0, space);
        content.addView(description);
        TextView address = label(context, server, 15);
        address.setTextIsSelectable(true);
        address.setPadding(0, 0, 0, space);
        content.addView(address);
        Button retryButton = new Button(context);
        retryButton.setText(text.apply("Try again"));
        retryButton.setOnClickListener(view -> retry.run());
        content.addView(retryButton, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        Button changeButton = new Button(context);
        changeButton.setText(text.apply("Change server"));
        changeButton.setOnClickListener(view -> change.run());
        content.addView(changeButton, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return scroll;
    }

    private static TextView label(Context context, String text, int size) {
        TextView view = new TextView(context);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(Color.rgb(28, 35, 39));
        return view;
    }
}
