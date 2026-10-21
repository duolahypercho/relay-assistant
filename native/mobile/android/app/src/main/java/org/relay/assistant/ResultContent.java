package org.relay.assistant;

import java.nio.charset.StandardCharsets;

final class ResultContent {
    interface Decoder { byte[] decode(String encoded); }
    static byte[] file(String name, String encoded, Decoder decoder) {
        if (name == null || name.isEmpty() || name.getBytes(StandardCharsets.UTF_8).length > 240 || name.equals(".") || name.equals("..") || name.contains("/") || name.contains("\\") || name.chars().anyMatch(Character::isISOControl) || encoded == null || encoded.length() > ((8 * 1024 * 1024 + 2) / 3) * 4)
            throw new IllegalArgumentException("Choose a valid file of 8 MB or less.");
        if (encoded.length() % 4 != 0) throw new IllegalArgumentException("Invalid file encoding.");
        int padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
        for (int i = 0; i < encoded.length() - padding; i++) {
            char c = encoded.charAt(i);
            if (!(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+' || c == '/'))
                throw new IllegalArgumentException("Invalid file encoding.");
        }
        byte[] bytes = decoder.decode(encoded);
        if (bytes.length > 8 * 1024 * 1024) throw new IllegalArgumentException("Choose a file of 8 MB or less.");
        return bytes;
    }
    static String escaped(String value) {
        return value.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;");
    }
    static String page(String source) {
        String policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
        String child = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"" + policy + "\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body>" + source + "</body></html>";
        return "<!doctype html><html lang=\"en\"><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; frame-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;background:white}iframe{display:block}</style></head><body><iframe title=\"Result preview\" sandbox=\"allow-scripts\" referrerpolicy=\"no-referrer\" allow=\"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'\" srcdoc=\"" + escaped(child) + "\"></iframe></body></html>";
    }
}
