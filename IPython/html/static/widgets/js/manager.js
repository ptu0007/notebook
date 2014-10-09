// Copyright (c) IPython Development Team.
// Distributed under the terms of the Modified BSD License.

define([
    "underscore",
    "backbone",
    "jquery",
    "base/js/namespace"
], function (_, Backbone, $, IPython) {
    "use strict";
    //--------------------------------------------------------------------
    // WidgetManager class
    //--------------------------------------------------------------------
    var WidgetManager = function (comm_manager, notebook) {
        // Public constructor
        WidgetManager._managers.push(this);

        // Attach a comm manager to the 
        this.keyboard_manager = notebook.keyboard_manager;
        this.notebook = notebook;
        this.comm_manager = comm_manager;
        this._models = {}; /* Dictionary of model ids and model instances */

        // Register with the comm manager.
        this.comm_manager.register_target('ipython.widget', $.proxy(this._handle_comm_open, this));
    };

    //--------------------------------------------------------------------
    // Class level
    //--------------------------------------------------------------------
    WidgetManager._model_types = {}; /* Dictionary of model type names (target_name) and model types. */
    WidgetManager._view_types = {}; /* Dictionary of view names and view types. */
    WidgetManager._managers = []; /* List of widget managers */

    WidgetManager.register_widget_model = function (model_name, model_type) {
        // Registers a widget model by name.
        WidgetManager._model_types[model_name] = model_type;
    };

    WidgetManager.register_widget_view = function (view_name, view_type) {
        // Registers a widget view by name.
        WidgetManager._view_types[view_name] = view_type;
    };

    //--------------------------------------------------------------------
    // Instance level
    //--------------------------------------------------------------------
    WidgetManager.prototype.display_view = function(msg, model) {
        // Displays a view for a particular model.
        var cell = this.get_msg_cell(msg.parent_header.msg_id);
        if (cell === null) {
            console.log("Could not determine where the display" + 
                " message was from.  Widget will not be displayed");
        } else {
            var that = this;
            this.create_view(model, {cell: cell, callback: function(view) {
                that._handle_display_view(view);
                if (cell.widget_subarea) {
                    cell.widget_subarea.append(view.$el);
                }
                view.trigger('displayed');
            }});
        }
    };

    WidgetManager.prototype._handle_display_view = function (view) {
        // Have the IPython keyboard manager disable its event
        // handling so the widget can capture keyboard input.
        // Note, this is only done on the outer most widgets.
        if (this.keyboard_manager) {
            this.keyboard_manager.register_events(view.$el);
        
        if (view.additional_elements) {
            for (var i = 0; i < view.additional_elements.length; i++) {
                    this.keyboard_manager.register_events(view.additional_elements[i]);
            }
        } 
        }
    };
    

    WidgetManager.prototype.create_view = function(model, options) {
        // Creates a view for a particular model.
        
        var view_name = model.get('_view_name');
        var view_mod = model.get('_view_module');
        var errback = options.errback || function(err) {console.log(err);};

        var instantiate_view = function(ViewType) {
            if (ViewType) {
                // If a view is passed into the method, use that view's cell as
                // the cell for the view that is created.
                options = options || {};
                if (options.parent !== undefined) {
                    options.cell = options.parent.options.cell;
                }

                // Create and render the view...
                var parameters = {model: model, options: options};
                var view = new ViewType(parameters);
                view.render();
                model.on('destroy', view.remove, view);
                options.callback(view);
            } else {
                errback({unknown_view: true, view_name: view_name,
                         view_module: view_mod});
            }
        };

        if (view_mod) {
            require([view_mod], function(module) {
                instantiate_view(module[view_name]);
            }, errback);
        } else {
            instantiate_view(WidgetManager._view_types[view_name]);
        }
    };

    WidgetManager.prototype.get_msg_cell = function (msg_id) {
        var cell = null;
        // First, check to see if the msg was triggered by cell execution.
        if (this.notebook) {
            cell = this.notebook.get_msg_cell(msg_id);
        }
        if (cell !== null) {
            return cell;
        }
        // Second, check to see if a get_cell callback was defined
        // for the message.  get_cell callbacks are registered for
        // widget messages, so this block is actually checking to see if the
        // message was triggered by a widget.
        var kernel = this.comm_manager.kernel;
        if (kernel) {
            var callbacks = kernel.get_callbacks_for_msg(msg_id);
            if (callbacks && callbacks.iopub &&
                callbacks.iopub.get_cell !== undefined) {
                return callbacks.iopub.get_cell();
            }
        }
        
        // Not triggered by a cell or widget (no get_cell callback 
        // exists).
        return null;
    };

    WidgetManager.prototype.callbacks = function (view) {
        // callback handlers specific a view
        var callbacks = {};
        if (view && view.options.cell) {

            // Try to get output handlers
            var cell = view.options.cell;
            var handle_output = null;
            var handle_clear_output = null;
            if (cell.output_area) {
                handle_output = $.proxy(cell.output_area.handle_output, cell.output_area);
                handle_clear_output = $.proxy(cell.output_area.handle_clear_output, cell.output_area);
            }

            // Create callback dict using what is known
            var that = this;
            callbacks = {
                iopub : {
                    output : handle_output,
                    clear_output : handle_clear_output,

                    // Special function only registered by widget messages.
                    // Allows us to get the cell for a message so we know
                    // where to add widgets if the code requires it.
                    get_cell : function () {
                        return cell;
                    },
                },
            };
        }
        return callbacks;
    };

    WidgetManager.prototype.get_model = function (model_id) {
        // Look-up a model instance by its id.
        var model = this._models[model_id];
        if (model !== undefined && model.id == model_id) {
            return model;
        }
        return null;
    };

    WidgetManager.prototype._handle_comm_open = function (comm, msg) {
        // Handle when a comm is opened.
        return this._create_model({model_name: msg.content.data.target_name, comm: comm});
    };

    WidgetManager.prototype.create_model = function (model_name, target_name, init_state_callback) {
        // Create and return a new widget model.
        //
        // Parameters
        // ----------
        // model_name: string
        //      Target name of the widget model to create.
        // target_name: string
        //      Target name of the widget in the back-end.
        // init_state_callback: (optional) callback
        //      Called when the first state push from the back-end is 
        //      recieved.
        return this._create_model({
            model_name: model_name, 
            target_name: target_name,
            init_state_callback: init_state_callback});
    };

    WidgetManager.prototype._create_model = function (options) {
        // Create and return a new widget model.
        //
        // Parameters
        // ----------
        // options: dictionary
        //  Dictionary of options with the following contents:
        //      model_name: string
        //          Target name of the widget model to create.
        //      target_name: (optional) string
        //          Target name of the widget in the back-end.
        //      comm: (optional) Comm
        //      init_state_callback: (optional) callback
        //          Called when the first state push from the back-end is 
        //          recieved.

        // Create a comm if it wasn't provided.
        var comm = options.comm;
        if (!comm) {
            comm = this.comm_manager.new_comm('ipython.widget', {'target_name': options.target_name});
        }

        // Create and return a new model that is connected to the comm.
        var that = this;
        
        var instantiate_model = function(ModelType) {
            var model_id = comm.comm_id;
            var widget_model = new ModelType(that, model_id, comm, options.init_state_callback);
            widget_model.on('comm:close', function () {
              delete that._models[model_id];
            });
            that._models[model_id] = widget_model;
        };
        
        var widget_type_name = msg.content.data.model_name;
        var widget_module = msg.content.data.model_module;

        if (widget_module) {
            // Load the module containing the widget model
            require([widget_module], function(mod) {
                if (mod[widget_type_name]) {
                    instantiate_model(mod[widget_type_name]);
                } else {
                    console.log("Error creating widget model: " + widget_type_name
                            + " not found in " + widget_module);
                }
            }, function(err) { console.log(err); });
        } else {
            // No module specified, load from the global models registry
            instantiate_model(WidgetManager._model_types[widget_type_name]);
        }
    };

    // Backwards compatability.
    IPython.WidgetManager = WidgetManager;

    return {'WidgetManager': WidgetManager};
});
