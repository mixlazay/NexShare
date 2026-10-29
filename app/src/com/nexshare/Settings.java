package com.nexshare;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;

/** SharedPreferences wrapper for the access settings (login mode, PIN, username/password). */
public final class Settings {

    public static final String MODE_NONE = "none";
    public static final String MODE_PIN = "pin";
    public static final String MODE_PASSWORD = "password";

    private Settings() { }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("nexshare", Context.MODE_PRIVATE);
    }

    // ---------- login mode ----------

    /** "none" | "pin" | "password". Defaults to "pin"; migrates the old pinEnabled flag. */
    public static String authMode(Context c) {
        SharedPreferences p = prefs(c);
        String m = p.getString("authMode", null);
        if (m != null) return m;
        return p.getBoolean("pinEnabled", true) ? MODE_PIN : MODE_NONE;
    }

    public static void setAuthMode(Context c, String mode) {
        if (!MODE_NONE.equals(mode) && !MODE_PIN.equals(mode) && !MODE_PASSWORD.equals(mode)) mode = MODE_PIN;
        prefs(c).edit().putString("authMode", mode).putBoolean("pinEnabled", !MODE_NONE.equals(mode)).apply();
    }

    public static boolean authRequired(Context c) {
        return !MODE_NONE.equals(authMode(c));
    }

    // Kept for existing callers; true when any login is required.
    public static boolean pinEnabled(Context c) {
        return authRequired(c);
    }

    public static void setPinEnabled(Context c, boolean on) {
        setAuthMode(c, on ? MODE_PIN : MODE_NONE);
    }

    // ---------- PIN ----------

    public static String pin(Context c) {
        SharedPreferences p = prefs(c);
        String pin = p.getString("pin", null);
        if (pin == null) {
            pin = newPin();
            p.edit().putString("pin", pin).apply();
        }
        return pin;
    }

    public static String regeneratePin(Context c) {
        String pin = newPin();
        prefs(c).edit().putString("pin", pin).apply();
        return pin;
    }

    private static String newPin() {
        return String.format(Locale.ROOT, "%06d", new SecureRandom().nextInt(1000000));
    }

    // ---------- username / password ----------

    public static String username(Context c) {
        return prefs(c).getString("username", "admin");
    }

    public static void setUsername(Context c, String name) {
        if (name == null || name.trim().isEmpty()) name = "admin";
        prefs(c).edit().putString("username", name.trim()).apply();
    }

    public static boolean hasPassword(Context c) {
        return prefs(c).getString("passHash", null) != null;
    }

    public static void setPassword(Context c, String plain) {
        String salt = randomHex(16);
        prefs(c).edit().putString("passHash", salt + ":" + hash(salt, plain)).apply();
    }

    public static boolean checkPassword(Context c, String plain) {
        String stored = prefs(c).getString("passHash", null);
        if (stored == null || plain == null) return false;
        int i = stored.indexOf(':');
        if (i < 0) return false;
        String salt = stored.substring(0, i);
        String expect = stored.substring(i + 1);
        return constantEquals(expect, hash(salt, plain));
    }

    private static String hash(String salt, String plain) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] cur = (salt + ":" + plain).getBytes(StandardCharsets.UTF_8);
            for (int i = 0; i < 12000; i++) cur = md.digest(cur);
            return hex(cur);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static boolean constantEquals(String a, String b) {
        if (a == null || b == null || a.length() != b.length()) return false;
        int r = 0;
        for (int i = 0; i < a.length(); i++) r |= a.charAt(i) ^ b.charAt(i);
        return r == 0;
    }

    private static String randomHex(int bytes) {
        byte[] b = new byte[bytes];
        new SecureRandom().nextBytes(b);
        return hex(b);
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format(Locale.ROOT, "%02x", x));
        return sb.toString();
    }

    // ---------- misc ----------

    public static String tunnelMode(Context c) {
        return prefs(c).getString("tunnelMode", "off");
    }

    public static String tunnelToken(Context c) {
        return prefs(c).getString("tunnelToken", "");
    }

    public static void setTunnel(Context c, String mode, String token) {
        prefs(c).edit().putString("tunnelMode", mode == null ? "off" : mode)
            .putString("tunnelToken", token == null ? "" : token).apply();
    }

    public static boolean keepScreenOn(Context c) {
        return prefs(c).getBoolean("keepScreenOn", true);
    }

    public static void setKeepScreenOn(Context c, boolean on) {
        prefs(c).edit().putBoolean("keepScreenOn", on).apply();
    }

    public static String serverName(Context c) {
        return prefs(c).getString("name", "NexShare-" + Build.MODEL.replace(' ', '-'));
    }
}
