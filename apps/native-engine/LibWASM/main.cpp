#include <JuceHeader.h>

#include "../../Source/CasperakiEngine.h"
// #include "../../Source/InstrumentalGenerator.h"
#include <emscripten.h>
#include <emscripten/val.h>
#include <emscripten/bind.h>

using namespace emscripten;

std::shared_ptr<CasperakiEngine> casperakiEngine{};
// std::unique_ptr<InstrumentalGenerator> instrumentalGenerator{};
bool controlStateCallbackEnabled = false;

class CasperakiWASMApp : public juce::JUCEApplication
{
public:
  CasperakiWASMApp() {}
  ~CasperakiWASMApp() {}

  void initialise(const juce::String &commandLine) override
  {
    DBG("CasperakiWASMApp initialise");

    casperakiEngine = std::make_shared<CasperakiEngine>(appControlStateCallback);

    // instrumentalGenerator = std::make_unique<InstrumentalGenerator>(
    //     "https://staging.casperaki.com",
    //     casperakiEngine,
    //     []() {
    //       printf("InstrumentalGenerator READY!\n");
    //     });
  }

  void shutdown() override
  {
    DBG("CasperakiWASMApp shutdown");
  }

  const juce::String getApplicationName() override
  {
    return "CasperakiWASMApp";
  }

  const juce::String getApplicationVersion() override
  {
    return "1.0";
  }

private:

  const std::function<void(CasperakiEngine::ControlState)> appControlStateCallback = [](CasperakiEngine::ControlState controlState1)
  {
    if (!controlStateCallbackEnabled){
      return;
    }

    MAIN_THREAD_ASYNC_EM_ASM(
        {
          window.casperakiEngineCallback({
            callbackType : "controlState",
            state : UTF8ToString($0),
            position : $1,
            length : $2,
            step : $3,
            beat : $4,
            bar : $5,
            segment : UTF8ToString($6),
            bpm : $7,
            chord : UTF8ToString($8)
          });
        },
        controlState1.state.c_str(), controlState1.position, controlState1.length, controlState1.step, controlState1.beat, controlState1.bar, controlState1.segment.c_str(), controlState1.bpm, controlState1.chord.c_str()
        );
  };
};

// this generates boilerplate code to launch our app class:
START_JUCE_APPLICATION(CasperakiWASMApp)

CasperakiEngine *getCasperakiEngine()
{
  std::cout << "getCasperakiEngine" << std::endl;
  return casperakiEngine.get();
}

// InstrumentalGenerator *getInstrumentalGenerator()
// {
//   std::cout << "getInstrumentalGenerator" << std::endl;
//   return instrumentalGenerator.get();
// }

void setControlStateCallback()
{
  controlStateCallbackEnabled = true;
}

#if JUCE_EMSCRIPTEN

#include <emscripten/bind.h>

EMSCRIPTEN_BINDINGS(casperaki_engine_wasm)
{
  function("getCasperakiEngine", &getCasperakiEngine, emscripten::allow_raw_pointers());
  // function("getInstrumentalGenerator", &getInstrumentalGenerator, emscripten::allow_raw_pointers());
  function("setControlStateCallback", &setControlStateCallback, emscripten::allow_raw_pointers());
}

#endif
