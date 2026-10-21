package org.relay.assistant;
public class ShareTextTest {
    static void rejected(CharSequence value) { try {ShareText.read(value);throw new AssertionError("Accepted invalid share");} catch(IllegalArgumentException expected){} }
    public static void main(String[] args) {
        if(!ShareText.read("Hello\nhttps://example.invalid/").equals("Hello\nhttps://example.invalid/"))throw new AssertionError();
        if(!ShareText.read("旅行 😀").equals("旅行 😀"))throw new AssertionError();
        rejected(null);rejected(" ");rejected("x".repeat(12001));
        if(ShareText.read("x".repeat(12000)).length()!=12000)throw new AssertionError();
        if(ShareText.validId("../context")||ShareText.validId(null)||!ShareText.validId("thread-123"))throw new AssertionError();
        System.out.println("PASS Android portable text and receipt validation; this is not an Android app runtime test.");
    }
}
