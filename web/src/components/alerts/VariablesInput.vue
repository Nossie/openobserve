<!-- Copyright 2023 OpenObserve Inc.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
-->

<template>
  <div class="col-12 q-py-sm variables-input "
  :class="{
    'flex tw-gap-2 items-center tw-w-1/2': variables.length == 0,
  }"
  >
    <div class="q-pb-xs custom-input-label text-bold">Variable
          <q-btn
          style="color: #A0A0A0;"
              no-caps
              padding="xs"
              class=""
              size="sm"
              flat
              icon="info_outline"
            >
              <q-tooltip>
              Variables are used to pass data from the alert to the destination.
            </q-tooltip>
          </q-btn>
        </div>
    <template v-if="!variables.length">
      <div class="flex justify-between items-center">

        <q-btn
          data-test="alert-variables-add-btn"
          label="Add Variable"
          size="sm"
          class="text-bold add-variable no-border q-py-sm"
          icon="add"
          color="primary"
          style="
            border-radius: 4px;
            text-transform: capitalize;
            color: #fff !important;
            font-size: 12px;
          "
          @click="addVariable"
        />
      </div>
    </template>
    <template v-else>
      <div
        v-for="(variable, index) in variables as any"
        :key="variable.uuid"
        class="q-col-gutter-sm q-pb-sm flex items-center"
        :data-test="`alert-variables-${index + 1}`"
      >
        <div class="q-ml-none">
          <q-input
            data-test="alert-variables-key-input"
            v-model="variable.key"
            color="input-border"
            :class="store.state.theme === 'dark' ? 'input-bg-dark' : 'input-bg-light'"
            stack-label
          
            outlined
            filled
            :placeholder="t('common.name')"
            dense
            tabindex="0"
          />
        </div>
        <div class="q-ml-none">
          <q-input
            data-test="alert-variables-value-input"
            v-model="variable.value"
            :placeholder="t('common.value')"
            color="input-border"
            :class="store.state.theme === 'dark' ? 'input-bg-dark' : 'input-bg-light'"
            stack-label
            outlined
            filled
            dense
            isUpdatingDestination
            tabindex="0"
            style="min-width: 250px"
          />
        </div>
        <div class="col-2 q-ml-none">
          <q-btn
            data-test="alert-variables-delete-variable-btn"
            :icon="outlinedDelete"
            class="q-ml-xs iconHoverBtn"
            :class="store.state?.theme === 'dark' ? 'icon-dark' : ''"
            padding="sm"
            unelevated
            size="sm"
            round
            flat
            :title="t('alert_templates.edit')"
            @click="removeVariable(variable)"
          />
          <q-btn
            data-test="alert-variables-add-variable-btn"
            v-if="index === variables.length - 1"
            icon="add"
            class="q-ml-xs iconHoverBtn"
            :class="store.state?.theme === 'dark' ? 'icon-dark' : ''"
            padding="sm"
            unelevated
            size="sm"
            round
            flat
            :title="t('alert_templates.edit')"
            @click="addVariable"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { defineProps } from "vue";
import { useI18n } from "vue-i18n";
import { outlinedDelete, outlinedInfo } from "@quasar/extras/material-icons-outlined";
import { useStore } from "vuex";

const props = defineProps({
  variables: {
    type: Array,
    required: true,
  },
});

const emits = defineEmits(["add:variable", "remove:variable"]);

const store = useStore();

const { t } = useI18n();

const removeVariable = (variable: any) => {
  emits("remove:variable", variable);
};

const addVariable = () => {
  emits("add:variable");
};
</script>

<style lang="scss">
.add-variable {
  .q-icon {
    margin-right: 4px !important;
    font-size: 15px !important;
  }
}

.variables-input {
  .q-btn {
    &.icon-dark {
      filter: none !important;
    }
  }
}

.input-bg-dark .q-field__control{
  background-color: #181a1b !important;
}
.input-bg-light .q-field__control{
  background-color: #ffffff !important;
}
</style>
