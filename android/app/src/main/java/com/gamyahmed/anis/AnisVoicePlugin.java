package com.gamyahmed.anis;

import android.content.Intent;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Arabic read-aloud that prefers the Google TTS engine explicitly (Samsung phones default to Samsung TTS). */
@CapacitorPlugin(name = "AnisVoice")
public class AnisVoicePlugin extends Plugin {

    private static final String GOOGLE = "com.google.android.tts";
    private TextToSpeech tts;
    private volatile boolean ready = false;
    private String engine = null;
    private final Map<String, PluginCall> pending = new HashMap<>();

    @Override
    public void load() {
        init();
    }

    private boolean hasGoogle() {
        try {
            getContext().getPackageManager().getPackageInfo(GOOGLE, 0);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void init() {
        if (tts != null) {
            try { tts.shutdown(); } catch (Exception ignored) {}
        }
        ready = false;
        engine = hasGoogle() ? GOOGLE : null;
        TextToSpeech.OnInitListener listener = status -> {
            ready = (status == TextToSpeech.SUCCESS);
            if (ready && tts != null) {
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {}
                    @Override public void onDone(String id) { finish(id, null); }
                    @Override public void onError(String id) { finish(id, "utterance error"); }
                    @Override public void onStop(String id, boolean interrupted) { finish(id, null); }
                });
            }
        };
        tts = (engine != null) ? new TextToSpeech(getContext(), listener, engine) : new TextToSpeech(getContext(), listener);
    }

    private void finish(String id, String error) {
        PluginCall c;
        synchronized (pending) { c = pending.remove(id); }
        if (c == null) return;
        if (error == null) c.resolve(); else c.reject(error);
    }

    private Locale pickArabic() {
        if (tts == null || !ready) return null;
        Locale best = null;
        try {
            Set<Locale> all = tts.getAvailableLanguages();
            if (all != null) {
                for (Locale l : all) {
                    if ("ar".equals(l.getLanguage())) {
                        if (best == null) best = l;
                        if ("EG".equals(l.getCountry())) { best = l; break; }
                    }
                }
            }
        } catch (Exception ignored) {}
        if (best != null) return best;
        String[] tags = {"ar-EG", "ar-XA", "ar-SA", "ar"};
        for (String t : tags) {
            Locale l = Locale.forLanguageTag(t);
            try {
                if (tts.isLanguageAvailable(l) >= TextToSpeech.LANG_AVAILABLE) return l;
            } catch (Exception ignored) {}
        }
        return null;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("ready", ready);
        r.put("google", hasGoogle());
        r.put("engine", engine == null ? "default" : engine);
        Locale a = pickArabic();
        r.put("arabic", a != null);
        r.put("locale", a == null ? "" : a.toLanguageTag());
        call.resolve(r);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        Float rate = call.getFloat("rate", 0.95f);
        if (!ready || tts == null) { call.reject("NOT_READY"); return; }
        Locale l = pickArabic();
        if (l == null) { call.reject("NO_ARABIC"); return; }
        tts.setLanguage(l);
        tts.setSpeechRate(rate == null ? 0.95f : rate);
        String id = UUID.randomUUID().toString();
        synchronized (pending) { pending.put(id, call); }
        Bundle params = new Bundle();
        int res = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, id);
        if (res != TextToSpeech.SUCCESS) finish(id, "speak failed");
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try { if (tts != null) tts.stop(); } catch (Exception ignored) {}
        String[] ids;
        synchronized (pending) { ids = pending.keySet().toArray(new String[0]); }
        for (String id : ids) finish(id, null);
        call.resolve();
    }

    @PluginMethod
    public void reinit(PluginCall call) {
        init();
        call.resolve();
    }

    private boolean start(Intent i) {
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @PluginMethod
    public void installArabic(PluginCall call) {
        Intent i = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
        if (hasGoogle()) i.setPackage(GOOGLE);
        boolean ok = start(i) || start(new Intent("com.android.settings.TTS_SETTINGS"));
        JSObject r = new JSObject();
        r.put("opened", ok);
        call.resolve(r);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        boolean ok = start(new Intent("com.android.settings.TTS_SETTINGS"))
            || start(new Intent(android.provider.Settings.ACTION_SETTINGS));
        JSObject r = new JSObject();
        r.put("opened", ok);
        call.resolve(r);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        init(); // pick up voices downloaded while the app was in the background
    }

    @Override
    protected void handleOnDestroy() {
        try { if (tts != null) tts.shutdown(); } catch (Exception ignored) {}
        super.handleOnDestroy();
    }
}
