package org.relay.assistant;
import java.util.Arrays;
import java.util.Base64;
public final class ResultContentTest {
    public static void main(String[] args) {
        byte[] input = new byte[]{0, 1, 2, 127, (byte)128, (byte)255};
        check(Arrays.equals(input, file("旅行.xlsx", Base64.getEncoder().encodeToString(input))), "exact bytes");
        for (String name : new String[]{"", ".", "..", "../secret", "a/b", "a\\b", "bad\nname", "a".repeat(241)}) {
            rejects(() -> file(name, "AA=="));
        }
        for (String encoded : new String[]{"invalid!", "AA", "====", "AA=Z", "AA\n=", "AA ="}) rejects(() -> file("file.bin", encoded));
        byte[] maximum = new byte[8 * 1024 * 1024];
        check(file("max.bin", Base64.getEncoder().encodeToString(maximum)).length == maximum.length, "maximum size");
        rejects(() -> file("large.bin", Base64.getEncoder().encodeToString(new byte[maximum.length + 1])));
        check(file("empty.txt", "").length == 0, "empty file");
        String hostile="\"><iframe src='https://example.com'><script>alert(1)</script>&quot;";
        String page=ResultContent.page(hostile);
        check(!page.contains(hostile), "attribute escape");
        check(page.contains("sandbox=\"allow-scripts\"") && !page.contains("allow-same-origin"), "opaque child");
        check(page.indexOf("Content-Security-Policy") < page.indexOf("srcdoc="), "parent policy first");
        System.out.println("Android result content: bytes, size boundaries, names and HTML escaping passed. This is a JVM test, not an Android device test.");
    }
    static byte[] file(String name, String encoded) { return ResultContent.file(name, encoded, value -> Base64.getDecoder().decode(value)); }
    static void check(boolean value,String label) { if (!value) throw new AssertionError(label); }
    static void rejects(Runnable run) { try { run.run(); } catch (IllegalArgumentException expected) { return; } throw new AssertionError("Invalid input accepted"); }
}
