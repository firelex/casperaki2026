package com.casperaki.casperaki_engine;

import android.Manifest;
import android.content.Context;
import android.os.Environment;

public class CasperakiEngineBridge {

    private ControlStateCallback controlStateCallback;

    static {
        System.loadLibrary("casperaki_engine_android");
    }

    private static boolean isExternalStorageReadOnly() {
        String extStorageState = Environment.getExternalStorageState();
        if (Environment.MEDIA_MOUNTED_READ_ONLY.equals(extStorageState)) {
            return true;
        }
        return false;
    }

    private static boolean isExternalStorageAvailable() {
        String extStorageState = Environment.getExternalStorageState();
        if (Environment.MEDIA_MOUNTED.equals(extStorageState)) {
            return true;
        }
        return false;
    }

    public void initialise(Context context, ControlStateCallback controlStateCallback) {
        System.out.println("Java: INIT START");
        System.out.println("Java: isExternalStorageReadOnly: " + isExternalStorageReadOnly());
        System.out.println("Java: isExternalStorageAvailable: " + isExternalStorageAvailable());
        this.controlStateCallback = controlStateCallback;
        native_initialiseJUCE(context);
        native_init();
        System.out.println("Java: INIT DONE");
    }

    public void testAsync(EngineCallback callback) {
        native_testAsync(callback);
    }

    public void setSong(String songData) {
        native_setSong(songData);
    }

    public void addInstrument(String instrumentData) {
        native_addInstrument(instrumentData);
    }

    public void removeInstrument(int instrumentId) {
        native_removeInstrument(instrumentId);
    }

    public void setInstrumentMute(int instrumentId, boolean mute) {
        native_setInstrumentMute(instrumentId, mute);
    }

    public void setInstrumentVolume(int instrumentId, float volume) {
        native_setInstrumentVolume(instrumentId, volume);
    }

    public void setBpm(int bpm) {
        native_setBpm(bpm);
    }

    public int getBpm() {
        return native_getBpm();
    }

    public void play() {
        native_play();
    }

    public void pause() {
        native_pause();
    }

    public void stop() {
        native_stop();
    }

    public void seekTo(String segment, int bar, int step) {
        native_seekTo(segment, bar, step);
    }
    
    public void playNote(int instrumentId, String noteDataString) {
    	native_playNote(instrumentId, noteDataString);
    }


    public void updateControlState(
            String state,
            double position,
            double length,
            int step,
            int beat,
            int bar,
            String segment,
            int bpm,
            String chord) {
        controlStateCallback.onControlStateUpdate(
                state,
                position,
                length,
                step,
                beat,
                bar,
                segment,
                bpm,
                chord);
    }

    private native void native_initialiseJUCE(Context appContext);

    private native void native_init();

    private native void native_testAsync(EngineCallback callback);

    private native void native_setSong(String songData);

    private native void native_addInstrument(String instrumentData, EngineCallback callback);

    private native void native_removeInstrument(int instrumentId);

    private native void native_setInstrumentMute(int instrumentId, boolean mute);

    private native void native_setInstrumentVolume(int instrumentId, float volume);

    private native void native_setBpm(int bpm);

    private native int native_getBpm();

    private native void native_play();

    private native void native_pause();

    private native void native_stop();

    private native void native_seekTo(String segment, int bar, int step);
    
    private native void native_playNote(int instrumentId, String noteDataString);
}
