/*
  ==============================================================================

    RestRequest.h
    Created: 16 Dec 2015 2:29:23pm
    Author:  Adam Wilson

  ==============================================================================
*/

#pragma once
#ifndef RESTREQUEST_H_INCLUDED
#define RESTREQUEST_H_INCLUDED

#include "JuceHeader.h"
#include "./json.hpp"

using namespace juce;
using json = nlohmann::json;

class RestRequest
{
public:

    RestRequest (String urlString) : url (urlString) {}
    RestRequest (URL url)          : url (url) {}
    RestRequest () {}

    struct Response
    {
        Result result;
        StringPairArray headers;
        json body;
        String bodyAsString;
        int status;

        Response() : result (Result::ok()), status (0) {} // not sure about using Result if we have to initialise it to ok...
    } response;


    RestRequest::Response execute ()
    {
        auto urlRequest = url.getChildURL (endpoint);
        bool hasFields = !fields.empty();
        if (hasFields)
        {
            urlRequest = urlRequest.withPOSTData (fields.dump());
        }

        juce::URL::ParameterHandling parameterHandling = verb == "GET" ? juce::URL::ParameterHandling::inAddress : juce::URL::ParameterHandling::inPostData;

        auto input (urlRequest.createInputStream (juce::URL::InputStreamOptions(parameterHandling)
                .withExtraHeaders(stringPairArrayToHeaderString(headers))
                .withResponseHeaders(&response.headers)
                .withStatusCode(&response.status)
                .withNumRedirectsToFollow(5)
                .withHttpRequestCmd(verb)
                .withConnectionTimeoutMs (10000)));

        response.result = checkInputStream (input);
        if (response.result.failed()) return response;

        response.bodyAsString = input->readEntireStreamAsString();
        try {
            response.body = json::parse(response.bodyAsString.toStdString());
            DBG(verb << " - " << urlRequest.toString (true) << " >>> " << response.bodyAsString.toStdString());

            // A valid JSON body is not enough — a 4xx/5xx status means the body is
            // an error payload, not data. Fold that into a failed result so callers
            // don't consume error bodies as valid responses.
            if (response.status >= 400)
                response.result = juce::Result::fail ("HTTP error " + juce::String (response.status) + ": " + response.bodyAsString);
            else
                response.result = juce::Result::ok();
        } catch (json::parse_error& e){
            response.result = juce::Result::fail(e.what());
        }

        return response;
    }


    RestRequest get (const String& endpoint)
    {
        RestRequest req (*this);
        req.verb = "GET";
        req.endpoint = endpoint;

        return req;
    }

    RestRequest post (const String& endpoint)
    {
        RestRequest req (*this);
        req.verb = "POST";
        req.endpoint = endpoint;

        return req;
    }

    RestRequest put (const String& endpoint)
    {
        RestRequest req (*this);
        req.verb = "PUT";
        req.endpoint = endpoint;

        return req;
    }

    RestRequest del (const String& endpoint)
    {
        RestRequest req (*this);
        req.verb = "DELETE";
        req.endpoint = endpoint;

        return req;
    }

    RestRequest field (const String& name, const json& value)
    {
        fields[name.toStdString()] = value;
        return *this;
    }

    RestRequest setFields (const json& newFields)
    {
        fields = newFields;
        return *this;
    }

    RestRequest header (const String& name, const String& value)
    {
        headers.set (name, value);
        return *this;
    }

    const URL& getURL() const
    {
        return url;
    }

    const String& getBodyAsString() const
    {
        return bodyAsString;
    }

private:
    URL url;
    StringPairArray headers;
    String verb;
    String endpoint;
    json fields;
    String bodyAsString;

    Result checkInputStream (std::unique_ptr<InputStream>& input)
    {
        if (! input) return Result::fail ("HTTP request failed, check your internet connection");
        return Result::ok();
    }

    static String stringPairArrayToHeaderString(StringPairArray stringPairArray)
    {
        String result;
        for (auto key : stringPairArray.getAllKeys())
        {
            result += key + ": " + stringPairArray.getValue(key, "") + "\n";
        }
        return result;
    }
};



#endif  // RESTREQUEST_H_INCLUDED
