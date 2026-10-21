package org.relay.assistant;

import java.net.URI;
import java.util.Locale;
import java.util.Arrays;

final class ServerAddress {
    static final String MESSAGE = "Enter your server’s HTTPS address, without a path, password or query.";
    static final String BLOCKED_PORT_MESSAGE = "This address uses a port the app cannot open. Check your server’s web address.";
    private static final java.util.Set<Integer> BLOCKED_PORTS = new java.util.HashSet<>(Arrays.asList(0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080));
    static String[] connectionInput(String value, boolean development) {
        try {
            URI url = new URI(value.trim());
            String fragment = url.getRawFragment();
            if (fragment == null) return new String[] { validate(value, development), "" };
            if (!"https".equalsIgnoreCase(url.getScheme()) || !fragment.matches("connect=[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException(MESSAGE);
            String server = validate(value.trim().substring(0, value.trim().indexOf('#')), development);
            return new String[] { server, server + "#" + fragment };
        } catch (Exception error) { throw new IllegalArgumentException(BLOCKED_PORT_MESSAGE.equals(error.getMessage()) ? BLOCKED_PORT_MESSAGE : MESSAGE); }
    }
    static String validate(String value, boolean development) {
        if (value == null || value.trim().isEmpty()) return "";
        try {
            URI url = new URI(value.trim());
            if (BLOCKED_PORTS.contains(url.getPort())) throw new IllegalArgumentException(BLOCKED_PORT_MESSAGE);
            String host = url.getHost();
            String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(Locale.ROOT);
            boolean secure = scheme.equals("https");
            boolean loopback = development && scheme.equals("http") && Arrays.asList("localhost", "127.0.0.1", "::1", "[::1]").contains(host == null ? "" : host);
            String path = url.getRawPath();
            if ((!secure && !loopback) || host == null || url.getRawUserInfo() != null || url.getRawQuery() != null || url.getRawFragment() != null || (path != null && !path.isEmpty() && !path.equals("/")) || url.getPort() == 0 || url.getPort() > 65535) throw new IllegalArgumentException(MESSAGE);
            return new URI(scheme, null, host, url.getPort(), "/", null, null).toString();
        } catch (Exception error) { throw new IllegalArgumentException(BLOCKED_PORT_MESSAGE.equals(error.getMessage()) ? BLOCKED_PORT_MESSAGE : MESSAGE); }
    }
}
