package org.relay.assistant;

// Kept independent of Android so the input limits can also be tested on a plain JVM.
final class ShareText {
    static String read(CharSequence value) {
        if (value == null || value.length() > 12000 || value.toString().trim().isEmpty())
            throw new IllegalArgumentException("Share plain text of up to 12,000 characters.");
        return value.toString();
    }
    static boolean validId(String value) { return value != null && value.matches("[a-zA-Z0-9_-]{1,100}"); }
}
