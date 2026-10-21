// SPDX-License-Identifier: MIT
package org.relay.assistant;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
public final class TemplateLinkTest {
    static String link(String source) { return "relay-assistant://template?url="+URLEncoder.encode(source,StandardCharsets.UTF_8); }
    static void bad(String value, boolean development) {
        try { TemplateLink.parse(value,development); throw new AssertionError("Accepted invalid template link: "+value); } catch(IllegalArgumentException expected) {}
    }
    public static void main(String[] args) {
        String source="https://publisher.example/share/assistant/"+"a".repeat(43);
        if(!source.equals(TemplateLink.parse(link(source),false))) throw new AssertionError("Valid HTTPS source changed");
        String local=source.replace("https://publisher.example","http://127.0.0.1:4310");
        if(!local.equals(TemplateLink.parse(link(local),true))) throw new AssertionError("Debug loopback failed");
        bad(link(local),false);
        for(String invalid:new String[]{source+"?key=secret",source+"#fragment",source+"/other",source.replace("https:","http:"),source.replace("publisher.example","user:password@publisher.example"),source.replace("publisher.example","publisher.example:22"),source.replace("assistant/","assistant/%61"),source+" ",source.replace("/share/","/x/../share/")}) bad(link(invalid),true);
        for(String invalid:new String[]{link(source)+"&url="+source,link(source)+"&extra=1",link(source)+"#fragment",link(source).replace("template?","template:443?"),link(source).replace("template?","user@template?"),link(source).replace("relay-assistant:","https:"),"\n"+link(source)}) bad(invalid,true);
        System.out.println("TemplateLink transport, path, credentials, query and release/debug checks passed.");
    }
}
