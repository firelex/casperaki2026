//
// Created by Tiago Alves on 18/01/2023.
//

#pragma once

#include <JuceHeader.h>
#include <future>
#include "./RestRequest.h"

class CasperakiApi
{
public:
    CasperakiApi(juce::URL _baseUrl = juce::URL{"https://staging.casperaki.com"}, juce::String _username = "sanmarino", juce::String _password = "whoweare")
    {
        baseUrl = _baseUrl;

        // TODO: these are dev credentials / a long-expired JWT baked into source.
        // Prefer the environment; fall back to the historical literals so the
        // default behaviour is unchanged when the vars are not set.
        username = juce::SystemStats::getEnvironmentVariable ("CASPERAKI_API_USERNAME", _username);
        password = juce::SystemStats::getEnvironmentVariable ("CASPERAKI_API_PASSWORD", _password);

        token = juce::SystemStats::getEnvironmentVariable ("CASPERAKI_API_TOKEN",
            "JWT eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJTaW1wbGUgQXV0aCIsInN1YiI6NCwibmFtZSI6InNhbm1hcmlubyIsImF1ZCI6InNpbXBsZWF1dGgiLCJpYXQiOjE2ODI0MTQxMjgsImV4cCI6MTY5MTA1NDEyOCwianRpIjoiZjZjZGM5NTAtOGUxZi00MDc3LTg0ZmUtNDUzNDA2NzQzYzU0In0.kfeEy4vuc7isKEh3_3lE2knbSxjMwWfAQFmikl8cjBTIR7WlVBifLL1EhjZx-UrtKTm1ORJvzCdQfG5RybKcMQ");
    };

    RestRequest::Response post(const String &endpoint, const json &postData)
    {
        if (!ensureLoggedIn())
        {
            RestRequest::Response res;
            res.result = juce::Result::fail("not logged in");
            return res;
        }

        RestRequest postRequest = createRequest().post(endpoint);
        postRequest.header("Authorization", token);

        DBG("Authorization header: ");
        DBG("Authorization: " + token);

        auto dataProps = postData.items();
        for (auto it = dataProps.begin(); it != dataProps.end(); it++)
            postRequest.field(it.key(), it.value());

        RestRequest::Response response = postRequest.execute();

        if (!response.result.wasOk())
        {
            juce::Logger::writeToLog("Request POST error " + juce::String(response.status) + ": " + juce::String(response.bodyAsString));
        }
        return response;
    }

    RestRequest::Response get(const String &endpoint, const json &getData = {})
    {
        if (!ensureLoggedIn())
        {
            RestRequest::Response res;
            res.result = juce::Result::fail("not logged in");
            return res;
        }

        RestRequest getRequest = createRequest().get(endpoint);

        getRequest.header("Authorization", token);

        if (!getData.empty())
        {
            auto dataProps = getData.items();
            for (auto it = dataProps.begin(); it != dataProps.end(); it++)
                getRequest.field(it.key(), it.value());
        }

        RestRequest::Response response = getRequest.execute();

        if (!response.result.wasOk())
        {
            DBG("Request GET " << endpoint << " error " << response.status << ": " << response.bodyAsString);
        }
        return response;
    }

    bool login()
    {
        auto loginRequest = createRequest();
        loginRequest.field("username", username.toStdString());
        loginRequest.field("password", password.toStdString());

        //        DBG ("\n");
        //        DBG ("Login Request: ");
        //        DBG (username);
        //        DBG (password);
        //        DBG (loginRequest.getBodyAsString());
        //        DBG ("\n");

        RestRequest::Response response = loginRequest.post("testLogin")
                                             .execute();
        DBG(response.body.dump(2));

        // Guard the JSON access: a failed request leaves body null, and indexing
        // a missing/null key with operator[] on a const json throws json::type_error.
        if (!response.result.wasOk() || !response.body.is_object() || !response.body.contains("status"))
        {
            DBG("login failed: " << response.status << ": " << response.bodyAsString);
            logout();
            return false;
        }

        status = response.body["status"].get<std::string>();

        if (status != "loggedIn")
        {
            DBG("login failed: " << response.status << ": " << response.bodyAsString);
            logout();
            return false;
        }

        if (response.body.contains("token"))
            token = response.body["token"].get<std::string>();
        if (response.body.contains("user"))
            userData = response.body["user"];
        return true;
    }

    void logout()
    {
        status = "loggedOut";
        token = "";
        userData = {};
    }

    json getUserData() { return userData; }

    bool ensureLoggedIn()
    {
        // NOTE: auth is intentionally bypassed — the baked-in token is used for
        // every request and the login flow below is currently dead code. Left in
        // place (rather than deleted) so it can be re-enabled by removing this line.
        return true;

        if (status == "loggedIn")
        {
            return true;
        }

        // try logging in
        return login();
    }

private:
    RestRequest createRequest()
    {
        auto request = RestRequest{baseUrl}.header("Content-Type", "application/json");

        return request;
    }

    juce::URL baseUrl;
    juce::String status{"loggedOut"};
    juce::String username{"sanmarino"};
    juce::String password{"whoweare"};
    juce::String token{};
    json userData;
};
