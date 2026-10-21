package org.relay.assistant;
import org.junit.Test;
import static org.junit.Assert.*;
public class ServerAddressTest {
    @Test public void connectionLinkSeparatesGrantFromSavedOrigin() {
        String token = "a".repeat(43), link = "https://relay.example/#connect=" + token;
        assertArrayEquals(new String[] {"https://relay.example/", link}, ServerAddress.connectionInput(link, false));
        assertArrayEquals(new String[] {"https://relay.example/", ""}, ServerAddress.connectionInput("https://relay.example", false));
        for (String invalid : new String[] {link + "x", link + "&next=evil", link.replace("https", "http"), "https://user:pass@relay.example/#connect=" + token, "https://relay.example/path#connect=" + token, "https://relay.example/?q=1#connect=" + token, "https://relay.example/#chat"}) {
            assertThrows(IllegalArgumentException.class, () -> ServerAddress.connectionInput(invalid, true));
        }
        assertArrayEquals(new String[] {"http://127.0.0.1:9000/", ""}, ServerAddress.connectionInput("http://127.0.0.1:9000", true));
    }
}
