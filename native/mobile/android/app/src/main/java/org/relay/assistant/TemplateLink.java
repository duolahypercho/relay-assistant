// SPDX-License-Identifier: MIT
package org.relay.assistant;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

final class TemplateLink {
    static String parse(String value, boolean development) {
        try {
            if (value == null || value.length() > 4096) throw new IllegalArgumentException();
            URI link = new URI(value);
            if (!"relay-assistant".equals(link.getScheme()) || !"template".equals(link.getHost()) || link.getPort() != -1 || link.getRawUserInfo() != null || link.getRawFragment() != null || !(link.getPath().isEmpty() || link.getPath().equals("/"))) throw new IllegalArgumentException();
            String query = link.getRawQuery();
            if (query == null || !query.startsWith("url=") || query.contains("&")) throw new IllegalArgumentException();
            String source = URLDecoder.decode(query.substring(4), StandardCharsets.UTF_8);
            if (source.length()>2048 || source.contains("\\") || source.matches("(?s).*\\s.*")) throw new IllegalArgumentException();
            URI url = new URI(source);
            if (url.getRawUserInfo()!=null || url.getRawQuery()!=null || url.getRawFragment()!=null || !url.getRawPath().matches("/share/assistant/[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException();
            ServerAddress.validate(new URI(url.getScheme(),null,url.getHost(),url.getPort(),"/",null,null).toString(), development);
            return url.toString();
        } catch(Exception error) { throw new IllegalArgumentException("This Relay template link is invalid."); }
    }
}
