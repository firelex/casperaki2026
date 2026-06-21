//
// Created by Tiago Alves on 30/04/2022.
//
#pragma once
#include <JuceHeader.h>

using namespace juce;

/** Display a separate desktop window for viewed and editing a value tree's
 property fields.
 */
class ValueTreeViewer : public Component {
    /** Display properties for a tree. */
    class PropertyEditor :
            public juce::PropertyPanel {
    public:
        PropertyEditor() {
            noEditValue = "not editable";
        }
        void setSource(ValueTree &tree) {
            clear();

            t = tree;

            const int maxChars = 200;

            Array<PropertyComponent *> pc;
            for (int i = 0; i < t.getNumProperties(); ++i) {
                const Identifier name = t.getPropertyName(i).toString();
                Value v = t.getPropertyAsValue(name, nullptr);
                TextPropertyComponent *tpc;

                if (v.getValue().isObject()) {
                    tpc = new TextPropertyComponent(noEditValue, name.toString(), maxChars, false);
                    tpc->setEnabled(false);
                } else {
                    tpc = new TextPropertyComponent(v, name.toString(), maxChars, false);
                }

                pc.add(tpc);
            }
            addProperties(pc);
        }

    private:
        Value noEditValue;
        ValueTree t;
        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PropertyEditor);
    };

    class Item :
            public TreeViewItem,
            public ValueTree::Listener {
    public:
        Item(PropertyEditor *propertiesEditor, ValueTree tree)
                :
                propertiesEditor(propertiesEditor),
                t(tree) {
            t.addListener(this);
        }

        ~Item() {
            clearSubItems();
        }

        bool mightContainSubItems() {
            return t.getNumChildren() > 0;
        }

        void itemOpennessChanged(bool isNowOpen) {
            clearSubItems();

            if (!isNowOpen) return;

            int children = t.getNumChildren();
            for (int i = 0; i < children; ++i)
                addSubItem(new Item(propertiesEditor, t.getChild(i)));
        }

        void paintItem(Graphics &g, int w, int h) {

            Font font;
            Font smallFont(11.0);

            if (isSelected())
                g.fillAll(Colours::white);

            const float padding = 20.0f;

            String typeName = t.getType().toString();

            const float nameWidth = font.getStringWidthFloat(typeName);
            const float propertyX = padding + nameWidth;

            g.setColour(Colours::black);

            g.setFont(font);

            g.drawText(t.getType().toString(), 0, 0, w, h, Justification::left, false);
            g.setColour(Colours::blue);

            g.setFont(smallFont);

            String propertySummary;

            for (int i = 0; i < t.getNumProperties(); ++i) {
                const Identifier name = t.getPropertyName(i).toString();
                propertySummary += " [" + name.toString() + "] " + t.getProperty(name).toString();
            }

            g.drawText(propertySummary, propertyX, 0, w - propertyX, h, Justification::left, true);
        }

        void itemSelectionChanged(bool isNowSelected) {
            if (isNowSelected) {
                t.removeListener(this);
                propertiesEditor->setSource(t);
                t.addListener(this);
            }
        }

        /* Enormous list of ValueTree::Listener options... */
        void valueTreePropertyChanged(ValueTree &treeWhosePropertyHasChanged, const Identifier &property) {
            if (t != treeWhosePropertyHasChanged) return;
            t.removeListener(this);
//            if (isSelected())
//                propertiesEditor->setSource(t);
            repaintItem();
            t.addListener(this);
        }
        void valueTreeChildAdded(ValueTree &parentTree, ValueTree &childWhichHasBeenAdded) {
            treeHasChanged();
        }
        void valueTreeChildRemoved(ValueTree &parentTree, ValueTree &childWhichHasBeenRemoved) {
            treeHasChanged();
        }
        void valueTreeChildOrderChanged(ValueTree &parentTreeWhoseChildrenHaveMoved) {
            treeHasChanged();
        }
        void valueTreeParentChanged(ValueTree &treeWhoseParentHasChanged) {
            treeHasChanged();
        }
        void valueTreeRedirected(ValueTree &treeWhichHasBeenChanged) {
            treeHasChanged();
        }

    private:
        PropertyEditor *propertiesEditor;
        ValueTree t;
        Array<Identifier> currentProperties;
        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(Item);
    };

    /** Display a tree. */
    class Editor :
            public Component {
    public:
        Editor() : layoutResizer(&layout, 1, false) {
            layout.setItemLayout(0, -0.1, -0.9, -0.6);
            layout.setItemLayout(1, 5, 5, 5);
            layout.setItemLayout(2, -0.1, -0.9, -0.4);

            setSize(1000, 700);
            treeView.setColour(TreeView::ColourIds::backgroundColourId, Colours::whitesmoke);
            addAndMakeVisible(treeView);
            addAndMakeVisible(propertyEditor);
            addAndMakeVisible(layoutResizer);
        }
        ~Editor() {
            treeView.setRootItem(nullptr);
        }

        void resized() {
            Component *comps[] = {&treeView, &layoutResizer, &propertyEditor};
            layout.layOutComponents(comps, 3, 0, 0, getWidth(), getHeight(), true, true);
        }

        void setTree(ValueTree newTree) {
            if (!newTree.isValid()) {
                treeView.setRootItem(nullptr);
            } else if (tree != newTree) {
                tree = newTree;
                treeView.setRootItem(new Item(&propertyEditor, tree));
            }
        }

    public:
        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(Editor);

        ValueTree tree;
        TreeView treeView;
        PropertyEditor propertyEditor;
        StretchableLayoutManager layout;
        StretchableLayoutResizerBar layoutResizer;
    };

public:
    ValueTreeViewer() {
        editor = new Editor();
        addAndMakeVisible(editor);
        centreWithSize(getWidth(), getHeight());
        setVisible(true);
    }
    ~ValueTreeViewer() {
        editor->setTree(ValueTree{});
    }
    void setSource(ValueTree &v) {
        editor->setTree(v);
    }
    void resized() override {
        editor->setBounds(getLocalBounds());
    }
private:

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ValueTreeViewer);
    ScopedPointer<Editor> editor;
};
