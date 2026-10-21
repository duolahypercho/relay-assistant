package org.relay.assistant;
import java.io.*;
import java.nio.file.*;
import java.util.*;
public class BackupContentTest {
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    static void rejected(Checked work) throws Exception { try { work.run(); throw new AssertionError("accepted invalid transfer"); } catch (IOException expected) {} }
    interface Checked { void run() throws Exception; }
    public static void main(String[] args) throws Exception {
        File root = Files.createTempDirectory("relay-backup-test-").toFile();
        byte[] bytes = new byte[BackupContent.CHUNK]; Arrays.fill(bytes, (byte)45); System.arraycopy("RELAY-COMPUTER-1".getBytes("UTF-8"), 0, bytes, 0, 16);
        String data = Base64.getEncoder().encodeToString(bytes);
        try (BackupContent file = new BackupContent(root)) {
            rejected(() -> file.append(0, Base64.getEncoder().encodeToString(new byte[60]), Base64.getDecoder()::decode, Base64.getEncoder()::encodeToString));
            for (int i = 0; i < 12; i++) file.append((long)i * bytes.length, data, Base64.getDecoder()::decode, Base64.getEncoder()::encodeToString);
            rejected(() -> file.append(0, data, Base64.getDecoder()::decode, Base64.getEncoder()::encodeToString));
            rejected(() -> file.finish(10)); file.finish(12L * bytes.length);
            check(file.file.length() == 12L * bytes.length);
            try (InputStream input = new FileInputStream(file.file)) { for (int i = 0; i < 12; i++) check(Arrays.equals(input.readNBytes(bytes.length), bytes)); check(input.read() == -1); }
        }
        check(root.list().length == 0); check(BackupContent.MAXIMUM == 8658257232L); root.delete();
        System.out.println("PASS Android encrypted backup stream, bounds, exact bytes, cancellation and cleanup");
    }
}
