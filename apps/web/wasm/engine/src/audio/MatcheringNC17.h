// Port of the legacy matchering limiter, Casperaki_NC17 (casperaki_engine/dependencies/
// matchering/Source/Casperaki_NC17.h, itself the AirWindows NC-17 "NCSeventeen", MIT,
// Chris Johnson). This is NOT the same as the vendored AirWindows NC-17 used by the mixer
// (src/audio/airwindows/NC17.aw.cpp): that is an older AirWindows revision whose
// denormal guard ("noisesource") and 32-bit dither (rand()-driven noise shaping) differ.
// Casperaki_NC17 uses the newer xorshift dither seeded from rand() in its constructor,
// so it is ported here on its own, keeping the processing code verbatim.
//
// Streaming: all state lives in members; the only locals carried between samples are
// reassigned before use, so processing a song in blocks of any size gives the same
// output as one call over the whole song.
//
// Determinism: the original seeds fpdL/fpdR with rand() (Casperaki_NC17.h:67-68) in a
// fresh process, i.e. glibc's rand() before any srand(). ditherSeedsOfFreshProcess()
// reproduces those two draws with the portable glibc-identical generator (airwindows/
// AwRand.h) without disturbing its shared state, so native and wasm builds draw the same.
#pragma once

#include "airwindows/AwRand.h"

#include <cmath>
#include <cstdint>
#include <math.h>
#include <stdexcept>
#include <utility>

namespace casperaki {
namespace matchering {

class CasperakiNC17 {
public:
    // Casperaki_NC17.h:67-68: fpd = 1.0; while (fpd < 16386) fpd = rand()*UINT32_MAX;
    static std::pair<uint32_t, uint32_t> ditherSeedsOfFreshProcess() {
        const aw::PortableRandState saved = aw::portableRandState();
        aw::seedPortableRand(1);
        uint32_t l = 1;
        while (l < 16386) l = (uint32_t)aw::portableRand() * UINT32_MAX;
        uint32_t r = 1;
        while (r < 16386) r = (uint32_t)aw::portableRand() * UINT32_MAX;
        aw::portableRandState() = saved;
        return {l, r};
    }

    // Casperaki_NC17.h:46-70 constructor, with the two rand()-drawn seeds passed in.
    CasperakiNC17(uint32_t ditherSeedL, uint32_t ditherSeedR) : fpdL(ditherSeedL), fpdR(ditherSeedR) {
        if (fpdL < 16386 || fpdR < 16386)
            throw std::invalid_argument("CasperakiNC17: dither seeds must be >= 16386 (as the constructor loop guarantees)");
    }

    // Casperaki_NC17.h:72 setParams(newA, newB): A = newA / 24.0, B = newB.
    void setParams(float newA, float newB) {
        A = newA / 24.0;
        B = newB;
    }

    // Casperaki_Effect.h:44 prepareToPlay.
    void prepareToPlay(double newSampleRate) {
        if (!(newSampleRate > 0.0)) throw std::invalid_argument("CasperakiNC17: sample rate must be positive");
        sampleRate = newSampleRate;
    }

    // Checked entry point: prepareToPlay must have run (the original would divide by an
    // uninitialised sample rate).
    void process(float* const* inputs, float* const* outputs, int sampleFrames) {
        if (!(sampleRate > 0.0)) throw std::logic_error("CasperakiNC17: process() before prepareToPlay()");
        if (sampleFrames < 0) throw std::invalid_argument("CasperakiNC17: negative frame count");
        processReplacing(inputs, outputs, sampleFrames);
    }

private:
    // Casperaki_NC17.h:78-396, verbatim. inputs and outputs may alias (each sample is read
    // before it is written), so in-place processing equals the original's copy-then-process
    // (Casperaki_Effect.h:63 processBufferReplacing).
    void processReplacing(float * const*inputs, float * const*outputs, int sampleFrames)
    {
        float* in1  =  inputs[0];
        float* in2  =  inputs[1];
        float* out1 = outputs[0];
        float* out2 = outputs[1];

        double inP2;
        double chebyshev;
        double overallscale = 1.0;
        overallscale /= 44100.0;
        overallscale *= sampleRate;

        double IIRscaleback = 0.0004716;
        double bassScaleback = 0.0002364;
        double trebleScaleback = 0.0005484;
        double addBassBuss = 0.000243;
        double addTrebBuss = 0.000407;
        double addShortBuss = 0.000326;
        IIRscaleback /= overallscale;
        bassScaleback /= overallscale;
        trebleScaleback /= overallscale;
        addBassBuss /= overallscale;
        addTrebBuss /= overallscale;
        addShortBuss /= overallscale;
        double limitingBass = 0.39;
        double limitingTreb = 0.6;
        double limiting = 0.36;
        double maxfeedBass = 0.972;
        double maxfeedTreb = 0.972;
        double maxfeed = 0.975;
        double bridgerectifier;
        double inputSampleL;
        double lowSampleL = 0.0;
        double highSampleL;
        double distSampleL;
        double minusSampleL;
        double plusSampleL;
        double inputSampleR;
        double lowSampleR = 0.0;
        double highSampleR;
        double distSampleR;
        double minusSampleR;
        double plusSampleR;
        double gain = pow(10.0,(A*24.0)/20);
        double outlevel = B;
        
        
        while (--sampleFrames >= 0)
        {
            inputSampleL = *in1;
            inputSampleR = *in2;
            if (fabs(inputSampleL)<1.18e-23) inputSampleL = fpdL * 1.18e-17;
            if (fabs(inputSampleR)<1.18e-23) inputSampleR = fpdR * 1.18e-17;

            inputSampleL *= gain;
            inputSampleR *= gain;
            
            if (flip)
            {
                iirSampleAL = (iirSampleAL * 0.9) + (inputSampleL * 0.1);
                lowSampleL = iirSampleAL;
                iirSampleAR = (iirSampleAR * 0.9) + (inputSampleR * 0.1);
                lowSampleR = iirSampleAR;
            }
            else
            {
                iirSampleBL = (iirSampleBL * 0.9) + (inputSampleL * 0.1);
                lowSampleL = iirSampleBL;
                iirSampleBR = (iirSampleBR * 0.9) + (inputSampleR * 0.1);
                lowSampleR = iirSampleBR;
            }
            highSampleL = inputSampleL - lowSampleL;
            highSampleR = inputSampleR - lowSampleR;
            flip = !flip;
            //we now have two bands and the original source
            
            inP2 = lowSampleL * lowSampleL;
            if (inP2 > 1.0) inP2 = 1.0; if (inP2 < -1.0) inP2 = -1.0;
            chebyshev = (2 * inP2);
            chebyshev *= basslevL;
            //second harmonic max +1
            if (basslevL > 0) basslevL -= bassScaleback;
            if (basslevL < 0) basslevL += bassScaleback;
            //this is ShortBuss, IIRscaleback is the decay speed. *2 for second harmonic, and so on
            bridgerectifier = fabs(lowSampleL);
            if (bridgerectifier > 1.57079633) bridgerectifier = 1.57079633;
            //max value for sine function
            bridgerectifier = sin(bridgerectifier);
            if (lowSampleL > 0.0) distSampleL = bridgerectifier;
            else distSampleL = -bridgerectifier;
            minusSampleL = lowSampleL - distSampleL;
            plusSampleL = lowSampleL + distSampleL;
            if (minusSampleL > maxfeedBass) minusSampleL = maxfeedBass;
            if (plusSampleL > maxfeedBass) plusSampleL = maxfeedBass;
            if (plusSampleL < -maxfeedBass) plusSampleL = -maxfeedBass;
            if (minusSampleL < -maxfeedBass) minusSampleL = -maxfeedBass;
            if (lowSampleL > distSampleL) basslevL += (minusSampleL*addBassBuss);
            if (lowSampleL < -distSampleL) basslevL -= (plusSampleL*addBassBuss);
            if (basslevL > 1.0)  basslevL = 1.0;
            if (basslevL < -1.0) basslevL = -1.0;
            bridgerectifier = fabs(lowSampleL);
            if (bridgerectifier > 1.57079633) bridgerectifier = 1.57079633;
            //max value for sine function
            bridgerectifier = sin(bridgerectifier);
            if (lowSampleL > 0.0) lowSampleL = bridgerectifier;
            else lowSampleL = -bridgerectifier;
            //apply the distortion transform for reals
            lowSampleL /= (1.0+fabs(basslevL*limitingBass));
            lowSampleL += chebyshev;
            //apply the correction measuresL
            
            inP2 = lowSampleR * lowSampleR;
            if (inP2 > 1.0) inP2 = 1.0; if (inP2 < -1.0) inP2 = -1.0;
            chebyshev = (2 * inP2);
            chebyshev *= basslevR;
            //second harmonic max +1
            if (basslevR > 0) basslevR -= bassScaleback;
            if (basslevR < 0) basslevR += bassScaleback;
            //this is ShortBuss, IIRscaleback is the decay speed. *2 for second harmonic, and so on
            bridgerectifier = fabs(lowSampleR);
            if (bridgerectifier > 1.57079633) bridgerectifier = 1.57079633;
            //max value for sine function
            bridgerectifier = sin(bridgerectifier);
            if (lowSampleR > 0.0) distSampleR = bridgerectifier;
            else distSampleR = -bridgerectifier;
            minusSampleR = lowSampleR - distSampleR;
            plusSampleR = lowSampleR + distSampleR;
            if (minusSampleR > maxfeedBass) minusSampleR = maxfeedBass;
            if (plusSampleR > maxfeedBass) plusSampleR = maxfeedBass;
            if (plusSampleR < -maxfeedBass) plusSampleR = -maxfeedBass;
            if (minusSampleR < -maxfeedBass) minusSampleR = -maxfeedBass;
            if (lowSampleR > distSampleR) basslevR += (minusSampleR*addBassBuss);
            if (lowSampleR < -distSampleR) basslevR -= (plusSampleR*addBassBuss);
            if (basslevR > 1.0)  basslevR = 1.0;
            if (basslevR < -1.0) basslevR = -1.0;
            bridgerectifier = fabs(lowSampleR);
            if (bridgerectifier > 1.57079633) bridgerectifier = 1.57079633;
            //max value for sine function
            bridgerectifier = sin(bridgerectifier);
            if (lowSampleR > 0.0) lowSampleR = bridgerectifier;
            else lowSampleR = -bridgerectifier;
            //apply the distortion transform for reals
            lowSampleR /= (1.0+fabs(basslevR*limitingBass));
            lowSampleR += chebyshev;
            //apply the correction measuresR
            
            inP2 = highSampleL * highSampleL;
            if (inP2 > 1.0) inP2 = 1.0; if (inP2 < -1.0) inP2 = -1.0;
            chebyshev = (2 * inP2);
            chebyshev *= treblevL;
            //second harmonic max +1
            if (treblevL > 0) treblevL -= trebleScaleback;
            if (treblevL < 0) treblevL += trebleScaleback;
            //this is ShortBuss, IIRscaleback is the decay speed. *2 for second harmonic, and so on
            bridgerectifier = fabs(highSampleL);
            if (bridgerectifier > 1.57079633) bridgerectifier = 1.57079633;
            //max value for sine function
            bridgerectifier = sin(bridgerectifier);
            if (highSampleL > 0.0) distSampleL = bridgerectifier;
            else distSampleL = -bridgerectifier;
            minusSampleL = highSampleL - distSampleL;
            plusSampleL = highSampleL + distSampleL;
            if (minusSampleL > maxfeedTreb) minusSampleL = maxfeedTreb;
            if (plusSampleL > maxfeedTreb) plusSampleL = maxfeedTreb;
            if (plusSampleL < -maxfeedTreb) plusSampleL = -maxfeedTreb;
            if (minusSampleL < -maxfeedTreb) minusSampleL = -maxfeedTreb;
            if (highSampleL > distSampleL) treblevL += (minusSampleL*addTrebBuss);
            if (highSampleL < -distSampleL) treblevL -= (plusSampleL*addTrebBuss);
            if (treblevL > 1.0)  treblevL = 1.0;
            if (treblevL < -1.0) treblevL = -1.0;
            bridgerectifier = fabs(highSampleL);
            if (bridgerectifier > 1.57079633) bridgerectifier = 1.57079633;
            //max value for sine function
            bridgerectifier = sin(bridgerectifier);
            if (highSampleL > 0.0) highSampleL = bridgerectifier;
            else highSampleL = -bridgerectifier;
            //apply the distortion transform for reals
            highSampleL /= (1.0+fabs(treblevL*limitingTreb));
            highSampleL += chebyshev;
            //apply the correction measuresL
            
            inP2 = highSampleR * highSampleR;
            if (inP2 > 1.0) inP2 = 1.0; if (inP2 < -1.0) inP2 = -1.0;
            chebyshev = (2 * inP2);
            chebyshev *= treblevR;
            //second harmonic max +1
            if (treblevR > 0) treblevR -= trebleScaleback;
            if (treblevR < 0) treblevR += trebleScaleback;
            //this is ShortBuss, IIRscaleback is the decay speed. *2 for second harmonic, and so on
            bridgerectifier = fabs(highSampleR);
            if (bridgerectifier > 1.57079633) bridgerectifier = 1.57079633;
            //max value for sine function
            bridgerectifier = sin(bridgerectifier);
            if (highSampleR > 0.0) distSampleR = bridgerectifier;
            else distSampleR = -bridgerectifier;
            minusSampleR = highSampleR - distSampleR;
            plusSampleR = highSampleR + distSampleR;
            if (minusSampleR > maxfeedTreb) minusSampleR = maxfeedTreb;
            if (plusSampleR > maxfeedTreb) plusSampleR = maxfeedTreb;
            if (plusSampleR < -maxfeedTreb) plusSampleR = -maxfeedTreb;
            if (minusSampleR < -maxfeedTreb) minusSampleR = -maxfeedTreb;
            if (highSampleR > distSampleR) treblevR += (minusSampleR*addTrebBuss);
            if (highSampleR < -distSampleR) treblevR -= (plusSampleR*addTrebBuss);
            if (treblevR > 1.0)  treblevR = 1.0;
            if (treblevR < -1.0) treblevR = -1.0;
            bridgerectifier = fabs(highSampleR);
            if (bridgerectifier > 1.57079633) bridgerectifier = 1.57079633;
            //max value for sine function
            bridgerectifier = sin(bridgerectifier);
            if (highSampleR > 0.0) highSampleR = bridgerectifier;
            else highSampleR = -bridgerectifier;
            //apply the distortion transform for reals
            highSampleR /= (1.0+fabs(treblevR*limitingTreb));
            highSampleR += chebyshev;
            //apply the correction measuresR
            
            inputSampleL = lowSampleL + highSampleL;
            inputSampleR = lowSampleR + highSampleR;
            
            inP2 = inputSampleL * inputSampleL;
            if (inP2 > 1.0) inP2 = 1.0; if (inP2 < -1.0) inP2 = -1.0;
            chebyshev = (2 * inP2);
            chebyshev *= cheblevL;
            //third harmonic max -1
            if (cheblevL > 0) cheblevL -= (IIRscaleback);
            if (cheblevL < 0) cheblevL += (IIRscaleback);
            //this is ShortBuss, IIRscaleback is the decay speed. *2 for second harmonic, and so on
            bridgerectifier = fabs(inputSampleL);
            if (bridgerectifier > 1.57079633) bridgerectifier = 1.57079633;
            //max value for sine function
            bridgerectifier = sin(bridgerectifier);
            if (inputSampleL > 0.0) distSampleL = bridgerectifier;
            else distSampleL = -bridgerectifier;
            minusSampleL = inputSampleL - distSampleL;
            plusSampleL = inputSampleL + distSampleL;
            if (minusSampleL > maxfeed) minusSampleL = maxfeed;
            if (plusSampleL > maxfeed) plusSampleL = maxfeed;
            if (plusSampleL < -maxfeed) plusSampleL = -maxfeed;
            if (minusSampleL < -maxfeed) minusSampleL = -maxfeed;
            if (inputSampleL > distSampleL) cheblevL += (minusSampleL*addShortBuss);
            if (inputSampleL < -distSampleL) cheblevL -= (plusSampleL*addShortBuss);
            if (cheblevL > 1.0)  cheblevL = 1.0;
            if (cheblevL < -1.0) cheblevL = -1.0;
            bridgerectifier = fabs(inputSampleL);
            if (bridgerectifier > 1.57079633) bridgerectifier = 1.57079633;
            //max value for sine function
            bridgerectifier = sin(bridgerectifier);
            if (inputSampleL > 0.0) inputSampleL = bridgerectifier;
            else inputSampleL = -bridgerectifier;
            //apply the distortion transform for reals
            inputSampleL /= (1.0+fabs(cheblevL*limiting));
            inputSampleL += chebyshev;
            //apply the correction measuresL

            inP2 = inputSampleR * inputSampleR;
            if (inP2 > 1.0) inP2 = 1.0; if (inP2 < -1.0) inP2 = -1.0;
            chebyshev = (2 * inP2);
            chebyshev *= cheblevR;
            //third harmonic max -1
            if (cheblevR > 0) cheblevR -= IIRscaleback;
            if (cheblevR < 0) cheblevR += IIRscaleback;
            //this is ShortBuss, IIRscaleback is the decay speed. *2 for second harmonic, and so on
            bridgerectifier = fabs(inputSampleR);
            if (bridgerectifier > 1.57079633) bridgerectifier = 1.57079633;
            //max value for sine function
            bridgerectifier = sin(bridgerectifier);
            if (inputSampleR > 0.0) distSampleR = bridgerectifier;
            else distSampleR = -bridgerectifier;
            minusSampleR = inputSampleR - distSampleR;
            plusSampleR = inputSampleR + distSampleR;
            if (minusSampleR > maxfeed) minusSampleR = maxfeed;
            if (plusSampleR > maxfeed) plusSampleR = maxfeed;
            if (plusSampleR < -maxfeed) plusSampleR = -maxfeed;
            if (minusSampleR < -maxfeed) minusSampleR = -maxfeed;
            if (inputSampleR > distSampleR) cheblevR += (minusSampleR*addShortBuss);
            if (inputSampleR < -distSampleR) cheblevR -= (plusSampleR*addShortBuss);
            if (cheblevR > 1.0)  cheblevR = 1.0;
            if (cheblevR < -1.0) cheblevR = -1.0;
            bridgerectifier = fabs(inputSampleR);
            if (bridgerectifier > 1.57079633) bridgerectifier = 1.57079633;
            //max value for sine function
            bridgerectifier = sin(bridgerectifier);
            if (inputSampleR > 0.0) inputSampleR = bridgerectifier;
            else inputSampleR = -bridgerectifier;
            //apply the distortion transform for reals
            inputSampleR /= (1.0+fabs(cheblevR*limiting));
            inputSampleR += chebyshev;
            //apply the correction measuresR
            
            if (outlevel < 1.0) {
                inputSampleL *= outlevel;
                inputSampleR *= outlevel;
            }
            
            if (inputSampleL > 0.95) inputSampleL = 0.95;
            if (inputSampleL < -0.95) inputSampleL = -0.95;
            if (inputSampleR > 0.95) inputSampleR = 0.95;
            if (inputSampleR < -0.95) inputSampleR = -0.95;
            //iron bar

            //begin 32 bit stereo floating point dither
            int expon; frexpf((float)inputSampleL, &expon);
            fpdL ^= fpdL << 13; fpdL ^= fpdL >> 17; fpdL ^= fpdL << 5;
            inputSampleL += ((double(fpdL)-uint32_t(0x7fffffff)) * 5.5e-36l * pow(2,expon+62));
            frexpf((float)inputSampleR, &expon);
            fpdR ^= fpdR << 13; fpdR ^= fpdR >> 17; fpdR ^= fpdR << 5;
            inputSampleR += ((double(fpdR)-uint32_t(0x7fffffff)) * 5.5e-36l * pow(2,expon+62));
            //end 32 bit stereo floating point dither

            *out1 = inputSampleL;
            *out2 = inputSampleR;

            *in1++;
            *in2++;
            *out1++;
            *out2++;
        }
    }

    double lastSampleL = 0.0;
    double iirSampleAL = 0.0;
    double iirSampleBL = 0.0;
    double basslevL = 0.0;
    double treblevL = 0.0;
    double cheblevL = 0.0;

    double lastSampleR = 0.0;
    double iirSampleAR = 0.0;
    double iirSampleBR = 0.0;
    double basslevR = 0.0;
    double treblevR = 0.0;
    double cheblevR = 0.0;

    bool flip = false;

    uint32_t fpdL;
    uint32_t fpdR;

    float A = 0.0;  // Louder
    float B = 1.0;  // Output

    double sampleRate = 0.0;
};

} // namespace matchering
} // namespace casperaki
