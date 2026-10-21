// SPDX-License-Identifier: MIT
package org.relay.assistant;

import java.util.Arrays;
import java.util.Locale;

final class ConnectionLocale {
    static String resolve(String explicit, String deviceLanguages) {
        if (Arrays.asList("en", "zh-CN", "zh-TW").contains(explicit)) return explicit;
        if (deviceLanguages != null) for (String value : deviceLanguages.split(",")) {
            Locale locale = Locale.forLanguageTag(value.replace('_', '-'));
            if (locale.getLanguage().equals("en")) return "en";
            if (locale.getLanguage().equals("zh")) {
                if (locale.getScript().equals("Hans")) return "zh-CN";
                if (locale.getScript().equals("Hant")) return "zh-TW";
                return Arrays.asList("TW", "HK", "MO").contains(locale.getCountry()) ? "zh-TW" : "zh-CN";
            }
        }
        return "en";
    }
}
