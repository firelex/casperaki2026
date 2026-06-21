//
// Created by Tiago Alves on 22/08/2022.
//

#import "CasperakiEngineInterface.h"

ControlStateCallback casperakiEngineCallback;

@implementation CasperakiEngineInterface {
    CasperakiEngine* casperakiEngine;
}

static void (^controlStateCallback)(struct State data);

- (id)initWithControlStateCallback:(void(^)(struct State))handler {
    NSLog(@"OBJ C INIIIIIT");
    self = [super init];
    if (self)
    {
        controlStateCallback = [handler copy];
        casperakiEngineCallback = [&](CasperakiEngine::ControlState controlState1) {
            NSLog(@"OBJ C CAALLLBACK");
            NSLog(@"state %s <%@>", controlState1.state.c_str(), [NSString stringWithUTF8String:controlState1.state.c_str()]);
            NSLog(@"pos %f/%f", controlState1.position, controlState1.length);
            NSLog(@"step %d/%d/%d bpm:", controlState1.step, controlState1.beat, controlState1.bar, controlState1.bpm);
            NSLog(@"Segment %s <%@>", controlState1.segment.c_str(), [NSString stringWithUTF8String:controlState1.segment.c_str()]);
            NSLog(@"chord %s <%@>", controlState1.chord.c_str(), [NSString stringWithUTF8String:controlState1.chord.c_str()]);

            struct State s{
                    [NSString stringWithUTF8String:controlState1.state.c_str()],
                    controlState1.position,
                    controlState1.length,
                    controlState1.step,
                    controlState1.beat,
                    controlState1.bar,
                    [NSString stringWithUTF8String:controlState1.segment.c_str()],
                    controlState1.bpm,
                    [NSString stringWithUTF8String:controlState1.chord.c_str()]
            };
            if (controlStateCallback != nil)
                controlStateCallback(s);

            NSLog(@"OBJ C CAALLLBACK DONE");

        };
//        handler(17);
        juce::MessageManager::getInstance();
        juce::initialiseJuce_GUI();
//        casperakiEngine = new CasperakiEngine([&](CasperakiEngine::ControlState controlState1) {
//            controlStateCallback(controlState1.beat); }
//        );
        casperakiEngine = new CasperakiEngine(casperakiEngineCallback);
        casperakiEngine->initialise();

        if (!casperakiEngine) self = nil;
    }
    return self;
}

- (void)testAsync:(void(^)())callback {
    casperakiEngine->testAsync([callback]() {
        std::cout << "CasperakiEngineInterface done" << std::endl;
        callback();
    });
}

- (void)setSong:(NSString *)data {
    std::string strData = std::string([data UTF8String]);
    casperakiEngine->setSong(strData);
}

- (void)addInstrument:(NSString *)data callback:(void(^)())callback {
    std::string strData = std::string([data UTF8String]);
    casperakiEngine->addInstrumentAsync(strData, callback);
}

- (void)removeInstrument:(int)instrumentId {
    casperakiEngine->removeInstrument(instrumentId);
}

- (void)setMuteForInstrument:(int)instrumentId mute:(bool)mute {
    casperakiEngine->setInstrumentMute(instrumentId, mute);
}

- (void)setVolumeForInstrument:(int)instrumentId volume:(float)volume {
    casperakiEngine->setInstrumentPostVolume(instrumentId, volume);
}

- (void)setBpm:(int)bpm {
    casperakiEngine->setBpm(bpm);
}

- (int)getBpm {
    return casperakiEngine->getControlState().bpm;
}

- (void)play {
    casperakiEngine->play();
}

- (void)pause {
    casperakiEngine->pause();
}

- (void)stop {
    casperakiEngine->stop();
}

- (void)seekToSegment:(NSString *)segment bar:(int)bar step:(double)step {
    std::string strSegment = std::string([segment UTF8String]);
    casperakiEngine->seekTo(strSegment, bar, step);
}


- (void)dealloc
{
    [super dealloc];
    delete casperakiEngine;
    [controlStateCallback release];
    controlStateCallback = nil;
}

- (void)playNote:(int)instrumentId note:(NSString*)note  {
    std::string noteDataStr = std::string ([note UTF8String]);
    casperakiEngine->playNote (instrumentId, noteDataStr);
}
@end
