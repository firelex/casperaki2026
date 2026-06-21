//
// Created by Tiago Alves on 09/09/2022.
//

#include "CasperakiEngineBridge.h"

#include <juce_core/native/juce_android_JNIHelpers.h>

CasperakiEngine *casperakiEngine = nullptr;


JNIEnv *envRef;
jobject javaBridgeRef;
jmethodID callbackId;
static JavaVM *jvm = 0;


void performCallback(CasperakiEngine::ControlState controlState) {
    DBG("performCallback: " << controlState.position << "/ " << controlState.length);

    JNIEnv *const env = juce::getEnv();

    env->CallVoidMethod(javaBridgeRef, callbackId,
                        env->NewStringUTF(controlState.state.c_str()),
                        controlState.position,
                        controlState.length,
                        controlState.step,
                        controlState.beat,
                        controlState.bar,
                        env->NewStringUTF(controlState.segment.c_str()),
                        controlState.bpm,
                        env->NewStringUTF(controlState.chord.c_str()));
}

ControlStateCallback casperakiEngineCallback = performCallback;

extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1init(JNIEnv *env, jobject thiz) {

    JNIEnv *const env2 = juce::getEnv();
    jclass clz = env2->FindClass("com/casperaki/casperaki_engine/CasperakiEngineBridge");
    javaBridgeRef = env2->NewGlobalRef(thiz);

    callbackId = env2->GetMethodID(
            clz,
            "updateControlState",
            "(Ljava/lang/String;DDIIILjava/lang/String;ILjava/lang/String;)V"
    );

    juce::MessageManager::getInstance();
    juce::initialiseJuce_GUI();
    casperakiEngine = new CasperakiEngine(casperakiEngineCallback);
//    casperakiEngine = new CasperakiEngine(nullptr);
    casperakiEngine->initialise();
}

extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1setSong(JNIEnv *env,
                                                                           jobject thiz,
                                                                           jstring song_data) {
    if (casperakiEngine == nullptr) return;

    std::string data{env->GetStringUTFChars(song_data, NULL)};
    casperakiEngine->setSong(data);
}


extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1removeInstrument(JNIEnv *env,
                                                                                    jobject thiz,
                                                                                    jint instrument_id) {
    if (casperakiEngine == nullptr) return;
    casperakiEngine->removeInstrument(instrument_id);
}

extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1setInstrumentMute(JNIEnv *env,
                                                                                     jobject thiz,
                                                                                     jint instrument_id,
                                                                                     jboolean mute) {
    if (casperakiEngine == nullptr) return;
    casperakiEngine->setInstrumentMute(instrument_id, mute);
}

extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1setInstrumentVolume(JNIEnv *env,
                                                                                       jobject thiz,
                                                                                       jint instrument_id,
                                                                                       jfloat volume) {
    if (casperakiEngine == nullptr) return;
    casperakiEngine->setInstrumentPostVolume(instrument_id, volume);
}

extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1setBpm(JNIEnv *env, jobject thiz,
                                                                          jint bpm) {
    if (casperakiEngine == nullptr) return;
    casperakiEngine->setBpm(bpm);
}

extern "C"
JNIEXPORT jint JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1getBpm(JNIEnv *env,
                                                                          jobject thiz) {
    if (casperakiEngine == nullptr) return 0;
    return casperakiEngine->getControlState().bpm;
}

extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1play(JNIEnv *env, jobject thiz) {
    if (casperakiEngine == nullptr) return;
    casperakiEngine->play();
}

extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1pause(JNIEnv *env,
                                                                         jobject thiz) {
    if (casperakiEngine == nullptr) return;
    casperakiEngine->pause();
}

extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1stop(JNIEnv *env, jobject thiz) {
    if (casperakiEngine == nullptr) return;
    casperakiEngine->stop();
}

extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1seekTo(JNIEnv *env, jobject thiz,
                                                                          jstring segment, jint bar,
                                                                          jint step) {
    if (casperakiEngine == nullptr) return;
    casperakiEngine->seekTo(std::string{env->GetStringUTFChars(segment, NULL)}, bar, step);
}

extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1initialiseJUCE(JNIEnv *env,
                                                                                  jobject thiz,
                                                                                  jobject app_context) {
    juce::Thread::initialiseJUCE(env, app_context);
    juce::MessageManager::getInstance();
}

extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1playNote(JNIEnv *env,
                                                                            jobject thiz,
                                                                            jint instrument_id,
                                                                            jstring noteDataStr) {
    if (casperakiEngine == nullptr) return;
    casperakiEngine->playNote(instrument_id,
                              std::string{env->GetStringUTFChars(noteDataStr, NULL)});
}


extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1testAsync(JNIEnv *env,
                                                                             jobject thiz,
                                                                             jobject callback) {
    std::cout << "C++ testAsync begin" << std::endl;
    TRACKTION_LOG("C++ testAsync begin DBG");
    JNIEnv *const env2 = juce::getEnv();
    jobject callbackref = env2->NewGlobalRef(callback);

    env->GetJavaVM(&jvm);

    jboolean isCopy(JNI_FALSE);

    jclass cbClass = env2->FindClass("com/casperaki/casperaki_engine/EngineCallback");
    jmethodID success_method = env2->GetMethodID(cbClass, "resolve", "()V");
    jmethodID reject_method = env2->GetMethodID(cbClass, "reject", "(Ljava/lang/String;)V");

    if (casperakiEngine == nullptr) {
        env2->CallVoidMethod(callbackref, reject_method,
                             env2->NewStringUTF("Error: casperakiEngine not initialised"));
        env2->DeleteGlobalRef(callbackref);
        return;
    };

    casperakiEngine->testAsync([success_method, callbackref]() {
        JNIEnv *env;
        jint rs = jvm->AttachCurrentThread(&env, NULL);

        env->CallVoidMethod(callbackref, success_method);
        env->DeleteGlobalRef(callbackref);
        jvm->DetachCurrentThread();
    });
}

extern "C"
JNIEXPORT void JNICALL
Java_com_casperaki_casperaki_1engine_CasperakiEngineBridge_native_1addInstrument(JNIEnv *env,
                                                                                 jobject thiz,
                                                                                 jstring instrument_data,
                                                                                 jobject callback) {
    std::cout << "C++ addInstrument begin" << std::endl;
    TRACKTION_LOG("C++ addInstrument begin");
    JNIEnv *const env2 = juce::getEnv();
    jobject callbackref = env2->NewGlobalRef(callback);

    env->GetJavaVM(&jvm);

    jboolean isCopy(JNI_FALSE);

    jclass cbClass = env2->FindClass("com/casperaki/casperaki_engine/EngineCallback");
    jmethodID success_method = env2->GetMethodID(cbClass, "resolve", "()V");
    jmethodID reject_method = env2->GetMethodID(cbClass, "reject", "(Ljava/lang/String;)V");



    if (casperakiEngine == nullptr) {
        TRACKTION_LOG("C++ addInstrument error");
        env2->CallVoidMethod(callbackref, reject_method,
                             env2->NewStringUTF("Error: casperakiEngine not initialised"));
        env2->DeleteGlobalRef(callbackref);
        return;
    };

    TRACKTION_LOG("C++ addInstrument calling addInstrumentAsync");
    casperakiEngine->addInstrumentAsync(std::string{env2->GetStringUTFChars(instrument_data, NULL)}, [success_method, callbackref]() {
        TRACKTION_LOG("C++ addInstrument addInstrumentAsync callback");
        JNIEnv *env;
        jint rs = jvm->AttachCurrentThread(&env, NULL);

        env->CallVoidMethod(callbackref, success_method);
        env->DeleteGlobalRef(callbackref);
        jvm->DetachCurrentThread();
    });
}