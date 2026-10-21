// SPDX-License-Identifier: MIT
package org.relay.assistant;
public class ConnectionLocaleTest {
    static void check(String expected, String value) { if (!expected.equals(value)) throw new AssertionError(expected + " != " + value); }
    public static void main(String[] args) {
        check("zh-TW", ConnectionLocale.resolve(null, "fr-FR,zh-Hant-HK,en-US"));
        check("en", ConnectionLocale.resolve(null, "en-GB,zh-CN"));
        check("zh-CN", ConnectionLocale.resolve(null, "zh-Hans-TW"));
        check("zh-TW", ConnectionLocale.resolve(null, "zh_HK"));
        check("en", ConnectionLocale.resolve(null, "fr"));
        check("zh-CN", ConnectionLocale.resolve("zh-CN", "en-US"));
        check("zh-TW", ConnectionLocale.resolve("https://example.invalid", "zh-Hant"));
        for (int port : new int[] {0, 9, 22, 25, 6000, 10080}) {
            try { ServerAddress.validate("https://127.0.0.1:" + port + "/", false); throw new AssertionError("Blocked port accepted"); }
            catch (IllegalArgumentException expected) { check(ServerAddress.BLOCKED_PORT_MESSAGE, expected.getMessage()); }
        }
        check("https://relay.example:8443/", ServerAddress.validate("https://relay.example:8443/", false));
        System.out.println("PASS Android connection locale selection, device fallback and explicit workspace language");
    }
}
