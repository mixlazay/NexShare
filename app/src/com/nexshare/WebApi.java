package com.nexshare;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.ThumbnailUtils;
import android.net.TrafficStats;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.LruCache;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.Inet4Address;
import java.net.URLEncoder;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.Deflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Routes for the web UI: static assets, auth, file operations and system stats. */
public class WebApi implements HttpServer.Handler {

    private final Context ctx;
    private final HttpServer[] serverRef;
    private final RootApi rootApi;
    private final Set<String> tokens = Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());
    private final Map<String, int[]> failures = new ConcurrentHashMap<>(); // ip -> {count, lockUntilSec}
    private final Map<String, byte[]> assetCache = new ConcurrentHashMap<>();
    private final LruCache<String, byte[]> thumbs = new LruCache<String, byte[]>(16 * 1024 * 1024) {
        @Override
        protected int sizeOf(String k, byte[] v) {
            return v.length;
        }
    };
    private final SecureRandom rnd = new SecureRandom();
    private long[] lastCpu;

    public WebApi(Context ctx, HttpServer[] serverRef) {
        this.ctx = ctx.getApplicationContext();
        this.serverRef = serverRef;
        this.rootApi = new RootApi(ctx);
    }

    @Override
    public void handle(HttpServer.Request req, HttpServer.Response res) throws IOException {
        String p = req.path;
        if (!p.startsWith("/api/")) {
            serveAsset(p, res);
            return;
        }
        if (p.startsWith("/api/root/")) {
            if (!authorized(req)) { res.error(401, "unauthorized"); return; }
            if (rootApi.handle(req, res)) return;
        }
        if (p.equals("/api/login")) {
            login(req, res);
            return;
        }
        if (p.equals("/api/session")) {
            JSONObject o = new JSONObject();
            put(o, "auth", authorized(req));
            put(o, "pinRequired", Settings.authRequired(ctx));
            put(o, "authMode", Settings.authMode(ctx));
            put(o, "username", Settings.username(ctx));
            put(o, "server", Build.MODEL);
            put(o, "flavor", Flavor.ROOT ? "root" : "normal");
            put(o, "version", Flavor.VERSION);
            put(o, "root", Flavor.ROOT && RootShell.available());
            res.json(200, o.toString());
            return;
        }
        if (!authorized(req)) {
            res.error(401, "unauthorized");
            return;
        }
        switch (p) {
            case "/api/logout": tokens.remove(req.cookie("ns_token")); res.json(200, "{}"); break;
            case "/api/roots": roots(res); break;
            case "/api/list": list(req, res); break;
            case "/api/search": search(req, res); break;
            case "/api/media": media(req, res); break;
            case "/api/file": file(req, res); break;
            case "/api/thumb": thumb(req, res); break;
            case "/api/zip": zip(req, res); break;
            case "/api/upload": upload(req, res); break;
            case "/api/mkdir": mkdir(req, res); break;
            case "/api/rename": rename(req, res); break;
            case "/api/delete": delete(req, res); break;
            case "/api/move": copyMove(req, res, true); break;
            case "/api/copy": copyMove(req, res, false); break;
            case "/api/system": system(res); break;
            case "/api/wallpaper": setWallpaper(req, res); break;
            case "/api/tunnel/status": tunnelStatus(res); break;
            case "/api/tunnel/start": tunnelStart(req, res); break;
            case "/api/tunnel/stop": TunnelManager.get(ctx).stop(); Settings.setTunnel(ctx, "off", Settings.tunnelToken(ctx)); tunnelStatus(res); break;
            case "/api/dl/list": dlList(res); break;
            case "/api/dl/add": dlAdd(req, res); break;
            case "/api/dl/torrent": dlTorrent(req, res); break;
            case "/api/dl/pause": DownloadManager.get(ctx).pause(req.param("id")); dlList(res); break;
            case "/api/dl/resume": DownloadManager.get(ctx).resume(req.param("id")); dlList(res); break;
            case "/api/dl/remove": DownloadManager.get(ctx).remove(req.param("id"), "1".equals(req.param("files"))); dlList(res); break;
            case "/api/dl/clear": DownloadManager.get(ctx).clearFinished(); dlList(res); break;
            default: res.error(404, "not found");
        }
    }

    // ---------- auth ----------

    private boolean authorized(HttpServer.Request req) {
        if (!Settings.authRequired(ctx)) return true;
        String t = req.cookie("ns_token");
        return t != null && tokens.contains(t);
    }

    private void login(HttpServer.Request req, HttpServer.Response res) throws IOException {
        int now = (int) (System.currentTimeMillis() / 1000);
        int[] f = failures.get(req.remote);
        if (f != null && f[1] > now) {
            res.error(429, "locked");
            return;
        }
        JSONObject body;
        try {
            body = new JSONObject(req.bodyString(4096));
        } catch (Exception e) {
            res.error(400, "bad request");
            return;
        }
        String mode = Settings.authMode(ctx);
        boolean ok;
        if (Settings.MODE_PASSWORD.equals(mode)) {
            ok = body.optString("username").trim().equals(Settings.username(ctx))
                && Settings.checkPassword(ctx, body.optString("password"));
        } else { // pin (or none, which is already allowed by authorized())
            ok = Settings.pin(ctx).equals(body.optString("pin").trim());
        }
        if (!ok) {
            if (f == null) f = new int[2];
            f[0]++;
            if (f[0] >= 5) {
                f[0] = 0;
                f[1] = now + 60;
            }
            failures.put(req.remote, f);
            res.error(401, Settings.MODE_PASSWORD.equals(mode) ? "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" : "wrong pin");
            return;
        }
        failures.remove(req.remote);
        byte[] b = new byte[24];
        rnd.nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format(Locale.ROOT, "%02x", x));
        String token = sb.toString();
        tokens.add(token);
        res.header("Set-Cookie", "ns_token=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000");
        res.json(200, "{\"ok\":true}");
    }

    // ---------- static ----------

    private void serveAsset(String p, HttpServer.Response res) throws IOException {
        if (p.equals("/") || p.isEmpty()) p = "/index.html";
        if (p.contains("..")) {
            res.error(400, "bad path");
            return;
        }
        String name = "web" + p;
        byte[] data = assetCache.get(name);
        if (data == null) {
            try (InputStream in = ctx.getAssets().open(name)) {
                data = readAll(in);
                assetCache.put(name, data);
            } catch (IOException e) {
                res.error(404, "not found");
                return;
            }
        }
        res.header("Cache-Control", "no-cache");
        res.bytes(200, mime(p), data);
    }

    // ---------- files ----------

    private List<File> rootDirs() {
        List<File> roots = new ArrayList<>();
        roots.add(Environment.getExternalStorageDirectory());
        File[] ext = ctx.getExternalFilesDirs(null);
        for (int i = 1; ext != null && i < ext.length; i++) {
            if (ext[i] == null) continue;
            String path = ext[i].getAbsolutePath();
            int idx = path.indexOf("/Android/data");
            if (idx > 0) roots.add(new File(path.substring(0, idx)));
        }
        return roots;
    }

    private File resolve(String path) throws IOException {
        if (path == null || path.isEmpty()) throw new SecurityException("no path");
        File f = new File(path).getCanonicalFile();
        String fp = f.getPath();
        for (File r : rootDirs()) {
            String rp = r.getCanonicalPath();
            if (fp.equals(rp) || fp.startsWith(rp + "/")) return f;
        }
        throw new SecurityException("outside storage");
    }

    private boolean isRoot(File f) throws IOException {
        for (File r : rootDirs()) if (r.getCanonicalPath().equals(f.getPath())) return true;
        return false;
    }

    private void roots(HttpServer.Response res) throws IOException {
        JSONArray arr = new JSONArray();
        int i = 0;
        for (File r : rootDirs()) {
            JSONObject o = new JSONObject();
            String path = r.getCanonicalPath();
            put(o, "name", i == 0 ? "Internal storage" : "SD card " + i);
            put(o, "path", path);
            try {
                StatFs st = new StatFs(path);
                put(o, "total", st.getTotalBytes());
                put(o, "free", st.getAvailableBytes());
            } catch (Exception ignored) { }
            put(o, "readable", r.listFiles() != null);
            arr.put(o);
            i++;
        }
        JSONObject out = new JSONObject();
        put(out, "roots", arr);
        res.json(200, out.toString());
    }

    private JSONObject entry(File f) {
        JSONObject o = new JSONObject();
        put(o, "name", f.getName());
        put(o, "path", f.getAbsolutePath());
        put(o, "dir", f.isDirectory());
        put(o, "size", f.isDirectory() ? 0 : f.length());
        put(o, "mtime", f.lastModified());
        put(o, "hidden", f.getName().startsWith("."));
        return o;
    }

    private void list(HttpServer.Request req, HttpServer.Response res) throws IOException {
        File dir = resolve(req.param("path"));
        if (!dir.isDirectory()) {
            res.error(404, "not a folder");
            return;
        }
        File[] files = dir.listFiles();
        if (files == null) {
            res.error(403, "no_permission");
            return;
        }
        JSONArray arr = new JSONArray();
        for (File f : files) arr.put(entry(f));
        JSONObject o = new JSONObject();
        put(o, "path", dir.getPath());
        put(o, "parent", isRoot(dir) ? JSONObject.NULL : dir.getParent());
        put(o, "entries", arr);
        res.json(200, o.toString());
    }

    private void search(HttpServer.Request req, HttpServer.Response res) throws IOException {
        File dir = resolve(req.param("path"));
        String q = req.param("q") == null ? "" : req.param("q").toLowerCase(Locale.ROOT);
        JSONArray arr = new JSONArray();
        if (!q.isEmpty()) walkSearch(dir, q, arr, 0);
        JSONObject o = new JSONObject();
        put(o, "entries", arr);
        res.json(200, o.toString());
    }

    private void walkSearch(File dir, String q, JSONArray out, int depth) {
        File[] files = dir.listFiles();
        if (files == null || depth > 12) return;
        for (File f : files) {
            if (out.length() >= 500) return;
            if (f.getName().toLowerCase(Locale.ROOT).contains(q)) out.put(entry(f));
            if (f.isDirectory() && !f.getName().equals("Android")) walkSearch(f, q, out, depth + 1);
        }
    }

    /** Recent photos and videos from the usual camera / picture folders, newest first. */
    private void media(HttpServer.Request req, HttpServer.Response res) throws IOException {
        String type = req.param("type") == null ? "all" : req.param("type");
        File base = Environment.getExternalStorageDirectory();
        List<File> found = new ArrayList<>();
        for (String d : new String[]{"DCIM", "Pictures", "Movies", "Music", "Download", "Recordings"}) collectMedia(new File(base, d), type, found, 0);
        Collections.sort(found, new Comparator<File>() {
            public int compare(File a, File b) {
                return Long.compare(b.lastModified(), a.lastModified());
            }
        });
        JSONArray arr = new JSONArray();
        for (int i = 0; i < found.size() && i < 2000; i++) arr.put(entry(found.get(i)));
        JSONObject o = new JSONObject();
        put(o, "entries", arr);
        res.json(200, o.toString());
    }

    private void collectMedia(File dir, String type, List<File> out, int depth) {
        File[] files = dir.listFiles();
        if (files == null || depth > 6) return;
        for (File f : files) {
            if (f.getName().startsWith(".")) continue;
            if (f.isDirectory()) collectMedia(f, type, out, depth + 1);
            else {
                String m = mime(f.getName());
                boolean img = m.startsWith("image/"), vid = m.startsWith("video/"), aud = m.startsWith("audio/");
                if ((type.equals("image") && img) || (type.equals("video") && vid) || (type.equals("audio") && aud)
                    || (type.equals("all") && (img || vid))) out.add(f);
            }
        }
    }

    private void file(HttpServer.Request req, HttpServer.Response res) throws IOException {
        File f = resolve(req.param("path"));
        if (!f.isFile()) {
            res.error(404, "not found");
            return;
        }
        long len = f.length();
        long start = 0, end = len - 1;
        boolean partial = false;
        String range = req.header("range");
        if (range != null && range.startsWith("bytes=") && !range.contains(",")) {
            String[] r = range.substring(6).split("-", -1);
            try {
                if (r[0].isEmpty()) {
                    start = Math.max(0, len - Long.parseLong(r[1]));
                } else {
                    start = Long.parseLong(r[0]);
                    if (!r[1].isEmpty()) end = Math.min(Long.parseLong(r[1]), len - 1);
                }
                partial = true;
            } catch (NumberFormatException ignored) { }
            if (start >= len || start > end) {
                res.header("Content-Range", "bytes */" + len);
                res.error(416, "bad range");
                return;
            }
        }
        res.header("Accept-Ranges", "bytes");
        res.header("Last-Modified", HttpServer.httpDate(f.lastModified()));
        String disp = "1".equals(req.param("dl")) ? "attachment" : "inline";
        res.header("Content-Disposition", disp + "; filename*=UTF-8''" + URLEncoder.encode(f.getName(), "UTF-8").replace("+", "%20"));
        if (partial) res.header("Content-Range", "bytes " + start + "-" + end + "/" + len);
        long count = end - start + 1;
        OutputStream out = res.begin(partial ? 206 : 200, mime(f.getName()), Math.max(count, 0));
        if ("HEAD".equals(req.method) || len == 0) return;
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            raf.seek(start);
            byte[] buf = new byte[65536];
            long left = count;
            while (left > 0) {
                int n = raf.read(buf, 0, (int) Math.min(buf.length, left));
                if (n < 0) break;
                out.write(buf, 0, n);
                left -= n;
            }
        }
    }

    private void thumb(HttpServer.Request req, HttpServer.Response res) throws IOException {
        File f = resolve(req.param("path"));
        int size = 320;
        try {
            if (req.param("s") != null) size = Math.max(64, Math.min(1024, Integer.parseInt(req.param("s"))));
        } catch (NumberFormatException ignored) { }
        String key = f.getPath() + "|" + f.lastModified() + "|" + size;
        byte[] data = thumbs.get(key);
        if (data == null) {
            Bitmap bmp = null;
            String m = mime(f.getName());
            try {
                if (m.startsWith("video/")) {
                    bmp = ThumbnailUtils.createVideoThumbnail(f.getPath(), MediaStore.Images.Thumbnails.MINI_KIND);
                } else if (m.startsWith("image/")) {
                    BitmapFactory.Options o = new BitmapFactory.Options();
                    o.inJustDecodeBounds = true;
                    BitmapFactory.decodeFile(f.getPath(), o);
                    int sample = 1;
                    while (Math.max(o.outWidth, o.outHeight) / (sample * 2) >= size) sample *= 2;
                    o = new BitmapFactory.Options();
                    o.inSampleSize = sample;
                    bmp = BitmapFactory.decodeFile(f.getPath(), o);
                }
            } catch (Throwable ignored) { }
            if (bmp == null) {
                res.error(404, "no thumbnail");
                return;
            }
            float scale = Math.min(1f, (float) size / Math.max(bmp.getWidth(), bmp.getHeight()));
            if (scale < 1f) {
                Bitmap s = Bitmap.createScaledBitmap(bmp, Math.round(bmp.getWidth() * scale), Math.round(bmp.getHeight() * scale), true);
                if (s != bmp) bmp.recycle();
                bmp = s;
            }
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 78, bo);
            bmp.recycle();
            data = bo.toByteArray();
            thumbs.put(key, data);
        }
        res.header("Cache-Control", "private, max-age=86400");
        res.bytes(200, "image/jpeg", data);
    }

    private void zip(HttpServer.Request req, HttpServer.Response res) throws IOException {
        List<File> items = new ArrayList<>();
        for (String p : req.params("p")) items.add(resolve(p));
        if (items.isEmpty()) {
            res.error(400, "nothing selected");
            return;
        }
        String name = items.size() == 1 ? items.get(0).getName() : "NexShare";
        res.header("Content-Disposition", "attachment; filename*=UTF-8''" + URLEncoder.encode(name + ".zip", "UTF-8").replace("+", "%20"));
        OutputStream out = res.begin(200, "application/zip", -1);
        ZipOutputStream z = new ZipOutputStream(new java.io.BufferedOutputStream(out, 65536));
        z.setLevel(Deflater.BEST_SPEED);
        for (File f : items) addZip(z, f, f.getName());
        z.finish();
        z.flush();
    }

    private void addZip(ZipOutputStream z, File f, String name) throws IOException {
        if (f.isDirectory()) {
            z.putNextEntry(new ZipEntry(name + "/"));
            z.closeEntry();
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) addZip(z, k, name + "/" + k.getName());
            return;
        }
        ZipEntry e = new ZipEntry(name);
        e.setTime(f.lastModified());
        z.putNextEntry(e);
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) z.write(buf, 0, n);
        } catch (IOException ignored) { }
        z.closeEntry();
    }

    private void upload(HttpServer.Request req, HttpServer.Response res) throws IOException {
        if (!"POST".equals(req.method) && !"PUT".equals(req.method)) {
            res.error(400, "use POST");
            return;
        }
        File dir = resolve(req.param("path"));
        String name = cleanName(req.param("name"));
        String rel = req.param("rel"); // optional sub-folder path for folder uploads
        if (rel != null && !rel.isEmpty()) {
            for (String part : rel.split("/")) {
                if (part.isEmpty() || part.equals(".") || part.equals("..")) continue;
                dir = new File(dir, cleanName(part));
            }
            dir = resolve(dir.getPath());
            if (!dir.isDirectory() && !dir.mkdirs()) {
                res.error(500, "cannot create folder");
                return;
            }
        }
        if (name == null || !dir.isDirectory()) {
            res.error(400, "bad target");
            return;
        }
        File target = uniqueFile(dir, name);
        File tmp = new File(dir, "." + target.getName() + ".nexpart");
        boolean ok = false;
        try (OutputStream out = new FileOutputStream(tmp)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = req.body.read(buf)) > 0) out.write(buf, 0, n);
            ok = req.body.remaining() == 0;
        } finally {
            if (!ok) tmp.delete();
        }
        if (!tmp.renameTo(target)) {
            tmp.delete();
            res.error(500, "cannot save");
            return;
        }
        String lm = req.param("mtime");
        if (lm != null) try {
            target.setLastModified(Long.parseLong(lm));
        } catch (NumberFormatException ignored) { }
        res.json(200, entry(target).toString());
    }

    private void mkdir(HttpServer.Request req, HttpServer.Response res) throws IOException {
        File dir = resolve(req.param("path"));
        String name = cleanName(req.param("name"));
        if (name == null) {
            res.error(400, "bad name");
            return;
        }
        File nd = new File(dir, name);
        if (nd.exists()) {
            res.error(409, "exists");
            return;
        }
        if (!nd.mkdirs()) {
            res.error(500, "cannot create");
            return;
        }
        res.json(200, entry(nd).toString());
    }

    private void rename(HttpServer.Request req, HttpServer.Response res) throws IOException {
        File f = resolve(req.param("path"));
        String name = cleanName(req.param("name"));
        if (name == null || isRoot(f)) {
            res.error(400, "bad name");
            return;
        }
        File nf = new File(f.getParentFile(), name);
        if (nf.exists()) {
            res.error(409, "exists");
            return;
        }
        if (!f.renameTo(nf)) {
            res.error(500, "cannot rename");
            return;
        }
        res.json(200, entry(nf).toString());
    }

    private void delete(HttpServer.Request req, HttpServer.Response res) throws IOException {
        int n = 0;
        for (String p : req.params("p")) {
            File f = resolve(p);
            if (isRoot(f)) continue;
            if (deleteRec(f)) n++;
        }
        res.json(200, "{\"deleted\":" + n + "}");
    }

    private boolean deleteRec(File f) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRec(k);
        }
        return f.delete();
    }

    private void copyMove(HttpServer.Request req, HttpServer.Response res, boolean move) throws IOException {
        File dst = resolve(req.param("dst"));
        if (!dst.isDirectory()) {
            res.error(400, "bad destination");
            return;
        }
        int n = 0;
        for (String p : req.params("p")) {
            File src = resolve(p);
            if (isRoot(src)) continue;
            if (dst.getPath().equals(src.getPath()) || dst.getPath().startsWith(src.getPath() + "/")) continue;
            File target = uniqueFile(dst, src.getName());
            boolean ok = move && src.renameTo(target);
            if (!ok) {
                ok = copyRec(src, target);
                if (ok && move) deleteRec(src);
            }
            if (ok) n++;
        }
        res.json(200, "{\"done\":" + n + "}");
    }

    private boolean copyRec(File src, File dst) {
        if (src.isDirectory()) {
            if (!dst.mkdirs()) return false;
            File[] kids = src.listFiles();
            boolean ok = true;
            if (kids != null) for (File k : kids) ok &= copyRec(k, new File(dst, k.getName()));
            return ok;
        }
        try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            dst.setLastModified(src.lastModified());
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private static String cleanName(String n) {
        if (n == null) return null;
        n = n.replace("/", "_").replace("\\", "_").replace("\0", "").trim();
        if (n.isEmpty() || n.equals(".") || n.equals("..")) return null;
        return n;
    }

    private static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; ; i++) {
            f = new File(dir, base + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
    }

    /** Sets the phone wallpaper from either a stored file (?path=) or a POSTed image body. */
    private void setWallpaper(HttpServer.Request req, HttpServer.Response res) throws IOException {
        android.graphics.Bitmap bmp;
        if (req.param("path") != null) {
            File f = resolve(req.param("path"));
            if (!f.isFile()) { res.error(404, "not found"); return; }
            bmp = android.graphics.BitmapFactory.decodeFile(f.getPath());
        } else {
            if (req.contentLength <= 0 || req.contentLength > 64 * 1024 * 1024) { res.error(400, "no image"); return; }
            byte[] data = new byte[(int) req.contentLength];
            int off = 0, n;
            while (off < data.length && (n = req.body.read(data, off, data.length - off)) > 0) off += n;
            bmp = android.graphics.BitmapFactory.decodeByteArray(data, 0, data.length);
        }
        if (bmp == null) { res.error(400, "ไม่ใช่รูปภาพ"); return; }
        try {
            android.app.WallpaperManager wm = android.app.WallpaperManager.getInstance(ctx);
            String which = req.param("which");
            if (Build.VERSION.SDK_INT >= 24 && "lock".equals(which)) wm.setBitmap(bmp, null, true, android.app.WallpaperManager.FLAG_LOCK);
            else if (Build.VERSION.SDK_INT >= 24 && "home".equals(which)) wm.setBitmap(bmp, null, true, android.app.WallpaperManager.FLAG_SYSTEM);
            else wm.setBitmap(bmp);
            bmp.recycle();
            res.json(200, "{\"ok\":true}");
        } catch (Exception e) {
            res.error(500, e.getMessage());
        }
    }

    // ---------- cloudflare tunnel ----------

    private void tunnelStatus(HttpServer.Response res) throws IOException {
        TunnelManager tm = TunnelManager.get(ctx);
        JSONObject o = new JSONObject();
        put(o, "supported", tm.supported());
        put(o, "state", tm.state().name().toLowerCase(Locale.ROOT));
        put(o, "url", tm.url());
        put(o, "error", tm.error());
        put(o, "mode", Settings.tunnelMode(ctx));
        put(o, "hasToken", !Settings.tunnelToken(ctx).isEmpty());
        put(o, "log", tm.logTail());
        res.json(200, o.toString());
    }

    private void tunnelStart(HttpServer.Request req, HttpServer.Response res) throws IOException {
        JSONObject b;
        try {
            b = new JSONObject(req.bodyString(1 << 16));
        } catch (Exception e) {
            res.error(400, "bad request");
            return;
        }
        String mode = b.optString("mode", "quick");
        String token = b.optString("token", Settings.tunnelToken(ctx));
        // Exposing the files to the internet without a PIN would be reckless: turn it on.
        if (!Settings.pinEnabled(ctx)) Settings.setPinEnabled(ctx, true);
        try {
            TunnelManager.get(ctx).start(mode, token);
        } catch (Exception e) {
            res.error(500, e.getMessage());
            return;
        }
        tunnelStatus(res);
    }

    // ---------- download station ----------

    private void dlList(HttpServer.Response res) throws IOException {
        DownloadManager dm = DownloadManager.get(ctx);
        JSONObject o = new JSONObject();
        put(o, "tasks", dm.list());
        put(o, "defaultDir", DownloadManager.defaultDir().getAbsolutePath());
        put(o, "torrent", dm.torrentSupported());
        res.json(200, o.toString());
    }

    private File dlDir(String p) throws IOException {
        if (p == null || p.isEmpty()) return DownloadManager.defaultDir();
        return resolve(p);
    }

    private void dlAdd(HttpServer.Request req, HttpServer.Response res) throws IOException {
        JSONObject body;
        try {
            body = new JSONObject(req.bodyString(1 << 20));
        } catch (Exception e) {
            res.error(400, "bad request");
            return;
        }
        File dir = dlDir(body.optString("dest", null));
        String urls = body.optString("urls", "");
        int added = 0;
        StringBuilder errors = new StringBuilder();
        for (String line : urls.split("\\s*\\n\\s*")) {
            line = line.trim();
            if (line.isEmpty()) continue;
            try {
                DownloadManager.get(ctx).addUrl(line, dir);
                added++;
            } catch (IOException e) {
                errors.append(e.getMessage()).append('\n');
            }
        }
        if (added == 0) {
            res.error(400, errors.length() > 0 ? errors.toString().trim() : "no links");
            return;
        }
        res.json(200, "{\"added\":" + added + "}");
    }

    private void dlTorrent(HttpServer.Request req, HttpServer.Response res) throws IOException {
        if (req.contentLength <= 0 || req.contentLength > 20 * 1024 * 1024) {
            res.error(400, "bad torrent file");
            return;
        }
        byte[] data = new byte[(int) req.contentLength];
        int off = 0, n;
        while (off < data.length && (n = req.body.read(data, off, data.length - off)) > 0) off += n;
        try {
            DownloadManager.get(ctx).addTorrent(null, data, dlDir(req.param("dest")));
        } catch (IOException e) {
            res.error(400, e.getMessage());
            return;
        }
        res.json(200, "{\"added\":1}");
    }

    // ---------- system ----------

    private void system(HttpServer.Response res) throws IOException {
        JSONObject o = new JSONObject();
        put(o, "name", Settings.serverName(ctx));
        put(o, "model", Build.MANUFACTURER + " " + Build.MODEL);
        put(o, "android", Build.VERSION.RELEASE);
        put(o, "sdk", Build.VERSION.SDK_INT);
        put(o, "uptime", SystemClock.elapsedRealtime());
        put(o, "cores", Runtime.getRuntime().availableProcessors());
        Inet4Address ip = MdnsResponder.lanAddress();
        put(o, "ip", ip == null ? "" : ip.getHostAddress());
        put(o, "host", MdnsResponder.HOST);
        put(o, "port", ServerService.PORT);
        HttpServer s = serverRef[0];
        put(o, "connections", s == null ? 0 : s.activeConnections.get());

        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        put(o, "memTotal", mi.totalMem);
        put(o, "memAvail", mi.availMem);

        put(o, "cpu", cpuPercent());

        StatFs st = new StatFs(Environment.getExternalStorageDirectory().getPath());
        put(o, "diskTotal", st.getTotalBytes());
        put(o, "diskFree", st.getAvailableBytes());

        Intent bat = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (bat != null) {
            int level = bat.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = bat.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            put(o, "battery", level < 0 ? -1 : Math.round(level * 100f / scale));
            put(o, "charging", bat.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0);
            put(o, "batteryTemp", bat.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0);
        }
        put(o, "rx", TrafficStats.getTotalRxBytes());
        put(o, "tx", TrafficStats.getTotalTxBytes());
        put(o, "time", System.currentTimeMillis());
        res.json(200, o.toString());
    }

    /** /proc/stat when readable; otherwise average current/max CPU frequency as a load estimate. */
    private synchronized double cpuPercent() {
        try (RandomAccessFile r = new RandomAccessFile("/proc/stat", "r")) {
            String[] t = r.readLine().trim().split("\\s+");
            long idle = Long.parseLong(t[4]) + Long.parseLong(t[5]);
            long total = 0;
            for (int i = 1; i < t.length; i++) total += Long.parseLong(t[i]);
            long[] cur = {total, idle};
            double pct = -1;
            if (lastCpu != null && cur[0] > lastCpu[0])
                pct = 100.0 * (1 - (double) (cur[1] - lastCpu[1]) / (cur[0] - lastCpu[0]));
            lastCpu = cur;
            if (pct >= 0) return Math.round(pct * 10) / 10.0;
        } catch (Exception ignored) { }
        double sum = 0;
        int n = 0;
        for (int i = 0; i < 16; i++) {
            long c = readLong("/sys/devices/system/cpu/cpu" + i + "/cpufreq/scaling_cur_freq");
            long m = readLong("/sys/devices/system/cpu/cpu" + i + "/cpufreq/cpuinfo_max_freq");
            if (c > 0 && m > 0) {
                sum += (double) c / m;
                n++;
            }
        }
        return n == 0 ? -1 : Math.round(sum / n * 1000) / 10.0;
    }

    private static long readLong(String path) {
        try (RandomAccessFile r = new RandomAccessFile(path, "r")) {
            return Long.parseLong(r.readLine().trim());
        } catch (Exception e) {
            return -1;
        }
    }

    // ---------- helpers ----------

    private static void put(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (Exception ignored) { }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }

    private static final Map<String, String> MIME = new HashMap<>();

    static {
        String[] m = {
            "html", "text/html; charset=utf-8", "htm", "text/html; charset=utf-8", "css", "text/css; charset=utf-8",
            "js", "application/javascript; charset=utf-8", "json", "application/json", "svg", "image/svg+xml",
            "txt", "text/plain; charset=utf-8", "log", "text/plain; charset=utf-8", "md", "text/plain; charset=utf-8",
            "csv", "text/plain; charset=utf-8", "xml", "text/xml; charset=utf-8", "ico", "image/x-icon",
            "jpg", "image/jpeg", "jpeg", "image/jpeg", "png", "image/png", "gif", "image/gif", "webp", "image/webp",
            "bmp", "image/bmp", "heic", "image/heic", "heif", "image/heif",
            "mp4", "video/mp4", "m4v", "video/mp4", "webm", "video/webm", "mkv", "video/x-matroska", "3gp", "video/3gpp",
            "mov", "video/quicktime", "avi", "video/x-msvideo",
            "mp3", "audio/mpeg", "m4a", "audio/mp4", "aac", "audio/aac", "ogg", "audio/ogg", "opus", "audio/ogg",
            "wav", "audio/wav", "flac", "audio/flac", "amr", "audio/amr",
            "pdf", "application/pdf", "zip", "application/zip", "apk", "application/vnd.android.package-archive",
        };
        for (int i = 0; i < m.length; i += 2) MIME.put(m[i], m[i + 1]);
    }

    static String mime(String name) {
        int dot = name.lastIndexOf('.');
        String t = dot >= 0 ? MIME.get(name.substring(dot + 1).toLowerCase(Locale.ROOT)) : null;
        return t == null ? "application/octet-stream" : t;
    }
}
