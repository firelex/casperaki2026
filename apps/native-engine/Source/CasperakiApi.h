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
        username = _username;
        password = _password;

        token = "JWT eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJTaW1wbGUgQXV0aCIsInN1YiI6NCwibmFtZSI6InNhbm1hcmlubyIsImF1ZCI6InNpbXBsZWF1dGgiLCJpYXQiOjE2ODI0MTQxMjgsImV4cCI6MTY5MTA1NDEyOCwianRpIjoiZjZjZGM5NTAtOGUxZi00MDc3LTg0ZmUtNDUzNDA2NzQzYzU0In0.kfeEy4vuc7isKEh3_3lE2knbSxjMwWfAQFmikl8cjBTIR7WlVBifLL1EhjZx-UrtKTm1ORJvzCdQfG5RybKcMQ";
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
        status = response.body["status"].get<std::string>();

        if (status != "loggedIn")
        {
            DBG("login failed: " << response.status << ": " << response.bodyAsString);
            logout();
            return false;
        }

        token = response.body["token"].get<std::string>();
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
