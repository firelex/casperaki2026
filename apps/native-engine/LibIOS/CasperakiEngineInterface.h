//
// Created by Tiago Alves on 22/08/2022.
//

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

#include "../../Source/CasperakiEngine.h"

struct State {
    NSString* state;
    double position;
    double length;
    int step;
    int beat;
    int bar;
    NSString* segment;
    int bpm;
    NSString* chord;
};


@interface CasperakiEngineInterface : NSObject {
}

- (id)initWithControlStateCallback:(void(^)(struct State))handler;

- (void)testAsync:(void(^)())callback;

- (void)setSong:(NSString*)data;

- (void)addInstrument:(NSString*)data callback:(void(^)())callback;
- (void)removeInstrument:(int)instrumentId;

- (void)setMuteForInstrument:(int)instrumentId mute:(bool)mute;
- (void)setVolumeForInstrument:(int)instrumentId volume:(float)volume;

- (void)setBpm:(int)bpm;
- (int)getBpm;

- (void)play;
- (void)pause;
- (void)stop;

- (void)seekToSegment:(NSString*)segment bar:(int) bar step:(double) step;

- (void)playNote:(int)instrumentId note:(NSString*)note;
@end
