// Generic adapter: wraps any vendored AirWindows plugin class (which exposes the
// uniform AirWindows surface — setSampleRate via the shim, setParameter, and
// processReplacing) as a casperaki::aw::Plugin. Each plugin's namespaced TU
// instantiates AwAdapter<ns::PluginClass>(ns::kNumParameters) in its factory.
#pragma once

#include "AwPlugins.h"

namespace casperaki {
namespace aw {

template <class T>
struct AwAdapter : Plugin {
    T p{nullptr};                 // AirWindows ctor takes audioMasterCallback (= void*)
    int nParams;
    explicit AwAdapter(int n) : nParams(n) {}

    int  numParams() const override { return nParams; }
    void setSampleRate(double sr) override { p.setSampleRate(sr); }
    void setParam(int index, float value) override { if (index < nParams) p.setParameter(index, value); }
    void process(float* const* in, float* const* out, int frames) override {
        p.processReplacing(const_cast<float**>(in), const_cast<float**>(out), frames);
    }
};

} // namespace aw
} // namespace casperaki
