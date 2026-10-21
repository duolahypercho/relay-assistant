package org.relay.assistant;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Bounded, ordered disk/provider work shared by the Activity and bridge; never on the UI thread. */
final class ShareWork {
    static final ThreadPoolExecutor IO = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(16), r -> {
        Thread thread = new Thread(r, "relay-shares"); thread.setDaemon(true); return thread;
    });
}
