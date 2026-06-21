package com.casperaki.casperaki_engine;

public interface ControlStateCallback {
    void onControlStateUpdate(String state,
                              double position,
                              double length,
                              int step,
                              int beat,
                              int bar,
                              String segment,
                              int bpm,
                              String chord);
}
