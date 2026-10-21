package org.relay.assistant;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.function.Function;

// The bridge never accepts a local path. Only a bounded encrypted file is staged.
final class BackupContent implements AutoCloseable {
    static final int CHUNK = 1024 * 1024;
    static final long MAXIMUM = 8L * 1024 * 1024 * 1024 + 65L * 1024 * 1024 + 8257L * 20 + 60;
    final String id = UUID.randomUUID().toString();
    final File file;
    private FileOutputStream output;
    private long bytes;
    BackupContent(File root) throws IOException {
        file = File.createTempFile("relay-backup-save-", ".relaybackup", root);
        output = new FileOutputStream(file);
    }
    synchronized long append(long offset, String encoded, Function<String, byte[]> decode, Function<byte[], String> encode) throws IOException {
        if (output == null || offset != bytes || encoded == null || encoded.length() > ((CHUNK + 2) / 3) * 4) throw new IOException("Invalid backup chunk");
        final byte[] data;
        try { data = decode.apply(encoded); } catch (Exception error) { throw new IOException("Invalid backup chunk"); }
        if (data.length < 1 || data.length > CHUNK || !encode.apply(data).equals(encoded) || bytes + data.length > MAXIMUM ||
            (bytes == 0 && (data.length < 16 || !new String(data, 0, 16, StandardCharsets.US_ASCII).equals("RELAY-COMPUTER-1")))) throw new IOException("Invalid backup chunk");
        output.write(data); bytes += data.length; return bytes;
    }
    synchronized void finish(long size) throws IOException {
        if (output == null || bytes != size || bytes < 60) throw new IOException("Incomplete backup");
        output.getFD().sync(); output.close(); output = null;
    }
    @Override public synchronized void close() throws IOException { try { if (output != null) output.close(); } finally { output = null; file.delete(); } }
    static void cleanAbandoned(File root) {
        File[] files = root.listFiles(); if (files == null) return;
        for (File file : files) if (file.getName().matches("relay-backup-save-[0-9]+\\.relaybackup") && file.isFile()) file.delete();
    }
}
