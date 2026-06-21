//
// Created by Tiago Alves on 05/05/2022.
//

#include "Instrument.h"

Instrument::Instrument (te::Edit& ed, j::var instrumentData, juce::String newBaseURL):
    edit (ed)
{
    id = getInstrumentId (instrumentData);

    name = instrumentData["name"];
    type = getType(instrumentData["type"]);
    lowLevelType = instrumentData["lowLevelType"];

    fxGroup = FX::getFXGroupFromLowLevelType (lowLevelType);

    DBG ("instrument id: " << id << " " << name << " FX Group: " << FX::instrumentGroupToString (fxGroup));
        
    baseURL = newBaseURL;
}

bool Instrument::isTransition()
{
    return type == transitionNoise || type == transitionSample || type == transitionPattern;
}

void Instrument::applySignalProcessor (const te::TimeRange& segmentTimeRange, const j::var &signalProcessorData)
{
    auto lowPassFilterData = signalProcessorData["lowPassFilter"];
    if (!!lowPassFilterData)
    {
        auto tracks = getAudioTracks();
        for (auto track : tracks)
        {
            // check if track has a low pass filter
            te::Plugin::Array trackPlugins = track->pluginList.getPlugins();
            te::Plugin::Ptr secondPlugin = trackPlugins[1];
            te::LowPassPlugin* lowPassPlugin = nullptr;
            te::Plugin::Ptr samplerPlugin = trackPlugins[0];
            DBG ("secondPlugin->getPluginType(): " << (secondPlugin == nullptr ? "<null>" : secondPlugin->getPluginType()));
            if (secondPlugin != nullptr && secondPlugin->getPluginType() == "lowpass")
            {
                lowPassPlugin = dynamic_cast<te::LowPassPlugin *> (secondPlugin.get());
            }
            else
            {
                // add lowpass plugin
                if ((lowPassPlugin = dynamic_cast<te::LowPassPlugin*> (edit.getPluginCache().createNewPlugin (te::LowPassPlugin::xmlTypeName, {}).get())))
                {
                    //'trackPlugins.size()' ensures that the plugin is added at the very end of the chain
                    track->pluginList.insertPlugin (*lowPassPlugin, 1, nullptr);
                }
                else
                {
                    jassertfalse; // could not create the LPF plugin
                }
            }

            // apply filter modifications
            te::AutomatableParameter::Ptr freqParam = lowPassPlugin->frequency;
            te::AutomationCurve freqCurve = freqParam->getCurve();
            freqCurve.addPoint(segmentTimeRange.getStart(), 30000, 0);
            te::TimePosition lastTime = segmentTimeRange.getStart();
            for (auto filterStep : *lowPassFilterData.getArray())
            {
                lastTime = segmentTimeRange.getStart() + te::TimeDuration::fromSeconds((double)filterStep["pointInSeconds"]);
                freqCurve.addPoint(lastTime, (float)filterStep["value"], 0.5);
            }
            // make sure the freq is set to 30000 by the end
            freqCurve.addPoint(lastTime, 30000, 0);
        }
    }

    auto volumeData = signalProcessorData["volume"];
    if (!!volumeData)
    {
        auto tracks = getAudioTracks();
        for (auto track : tracks)
        {
            // add volume ramps
            te::AutomatableParameter::Ptr volParam = track->getVolumePlugin()->getAutomatableParameterByID("volume");
            te::AutomationCurve curve = volParam->getCurve();

            double defaultVolume = curve.getValueAt(segmentTimeRange.getStart());
            double nextDefaultVolume = curve.getValueAt(segmentTimeRange.getEnd());

            curve.addPoint(segmentTimeRange.getStart(), defaultVolume, 0);
            te::TimePosition lastTime = segmentTimeRange.getStart();
            int volumeStepIndex = 0;
            for (auto volumeStep : *volumeData.getArray())
            {
                lastTime = segmentTimeRange.getStart() + te::TimeDuration::fromSeconds((double)volumeStep["pointInSeconds"]);
                if (volumeStepIndex < volumeData.getArray()->size() - 1)
                {
                    curve.addPoint(lastTime, te::decibelsToVolumeFaderPosition((float)volumeStep["value"]), 0);
                }
                else
                {
                    // Set the volume to the default of the next clip
                    curve.addPoint(lastTime, nextDefaultVolume, 0);
                }
                volumeStepIndex++;
            }

        }
    }
}

//How we define the class to use with the instrument type string
Instrument::Type Instrument::getType (j::String typeStr)
{
    static std::unordered_map<j::String, Type> const typeTable =
    {
        { "drums", Type::drums },
        { "basses", Type::basses },
        { "leadSynths", Type::leadSynths },
        { "synths", Type::synths },
        { "keys", Type::keys },
        { "popBrass", Type::popBrass },
        { "popStrings", Type::popStrings },
        { "acousticGuitars", Type::acousticGuitars },
        { "electricGuitars", Type::electricGuitars },
        { "orchestral", Type::synths },
        { "percussionLoops", Type::loop },
        { "percussion", Type::loop },
        { "transitionNoise", Type::transitionNoise },
        { "transitionSample", Type::transitionSample },
        { "transitionPattern", Type::transitionPattern },
        { "orchestral", Type::orchestral },
        { "vocals", Type::vocals },
    };
    
    std::unordered_map<j::String, Type>::const_iterator itg = typeTable.find (typeStr);
    if (itg == typeTable.end())
    {
        juce::Logger::writeToLog ("Type " + typeStr + " does not exist in table");
        jassertfalse;
    }
    else return itg.operator->()->second;
}

int Instrument::getInstrumentId (const j::var &instrumentData)
{
    if (instrumentData.hasProperty ("id"))
    {
        return (int) instrumentData["id"];
    }
    else
    {
        juce::Logger::writeToLog ("Instrument " + instrumentData["id"].toString() + " does not exist");
        jassertfalse;
    }
}
