#include <fstream>
/* File Helpers */

juce::File exportFileToWAV(juce::AudioBuffer<float> bufferToExport, juce::String name)
{
  juce::WavAudioFormat format;
  std::unique_ptr<juce::AudioFormatWriter> writer;
  juce::File file = juce::File::getCurrentWorkingDirectory().getChildFile(name);
  writer.reset(format.createWriterFor(new juce::FileOutputStream(file),
                                      44100, bufferToExport.getNumChannels(), 32, {}, 0));

  if (writer != nullptr)
  {
    writer->writeFromAudioSampleBuffer(bufferToExport, 0, bufferToExport.getNumSamples());
  }

  // return exported file
  return file;
}

juce::AudioBuffer<float> readAudioFromBasicFormats(juce::File file, tracktion_engine::Edit &edit)
{
  juce::AudioFormatManager formatManager;
  formatManager.registerBasicFormats();
  std::ifstream in(file.getFullPathName().toUTF8());

  if (file != juce::File{}) // [9]
  {
    auto reader = formatManager.createReaderFor(file.createInputStream());
    juce::AudioBuffer<float> readBuffer;
    readBuffer.setSize(reader->numChannels, (int)reader->lengthInSamples);

    if (reader != nullptr)
    {

      DBG("Length " + juce::String(reader->lengthInSamples));

      readBuffer.clear();
      bool hasLoaded = reader->read(readBuffer.getArrayOfWritePointers(), reader->numChannels, 0, (int)reader->lengthInSamples);

      if (hasLoaded)
        DBG("has loaded");
      else
        DBG("has not loaded");

      return readBuffer;
    }
  }

  // If the system is unable to read a file, we return an empty buffer
  std::cerr << "Unable to read audio file";
  return juce::AudioBuffer<float>();
}

juce::String getEditSampleFolderName(const tracktion_engine::Edit &edit)
{
  juce::String editSampleFolderName = edit.editFileRetriever().getParentDirectory().getFullPathName();
  editSampleFolderName << "/samples/";
  return editSampleFolderName;
}

//
juce::String getEditDirCopyFile(const tracktion_engine::Edit &edit, juce::File tempFile)
{
  if (!(edit.editFileRetriever && edit.editFileRetriever().existsAsFile()))
  {
    return tempFile.getFullPathName(); // don't create a copy
  }

  juce::String editSampleFolderName = getEditSampleFolderName(edit);

  juce::File editSampleFolder = juce::File::getCurrentWorkingDirectory().getChildFile(editSampleFolderName);

  editSampleFolder.createDirectory();

  juce::String newFileName{editSampleFolderName};
  newFileName << tempFile.getFileName();

  juce::File newFile = juce::File::getCurrentWorkingDirectory().getChildFile(newFileName);
  return newFile.getRelativePathFrom(edit.editFileRetriever().getParentDirectory());
}

juce::File copyFileToEditDir(const tracktion_engine::Edit &edit, juce::File tempFile)
{
  DBG("Getting edit directory and copying file: " + getEditDirCopyFile(edit, tempFile));

  juce::String editDirCopyFilePath = getEditDirCopyFile(edit, tempFile);

  juce::File editDirCopyFile = juce::File::getCurrentWorkingDirectory().getChildFile(editDirCopyFilePath);
  juce::String newFileName = editDirCopyFile.getFullPathName();
  juce::String pathName = tempFile.getFullPathName();

  //       DBG ("Looking for temp file in " + pathName);
  if (newFileName == pathName)
  {
    return tempFile; // don't create a copy
  }

  juce::File newFile = edit.editFileRetriever().getParentDirectory().getChildFile(newFileName);
  tempFile.copyFileTo(newFile);
  return newFile;
}

juce::File copyDecodedFileToEditDir(tracktion_engine::Edit &edit, juce::File tempFile)
{
  // This function should read an ogg and convert it to wav?
  juce::String pathName = tempFile.getFullPathName();
  juce::AudioBuffer<float> audio = readAudioFromBasicFormats(tempFile, edit);
  auto encodedFile = exportFileToWAV(audio, pathName);
  return encodedFile;
}


