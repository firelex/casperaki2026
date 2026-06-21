package com.casperaki.casperaki_engine;

public interface EngineCallback {
    void resolve();
    void reject(String reason);
}

